import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Broker keys live in the operating system's own keychain: Credential Manager on
// Windows, the login keychain on macOS, and the Secret Service on Linux. A secret is
// passed on stdin, never as an argument, where other processes could read it.

export type KeyRunner = (command: string, args: string[], input: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const keyRunner: KeyRunner = (command, args, input) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

// Windows PowerShell 5.1 reaches Credential Manager through advapi32. The script comes
// encoded, so no shell reads it; the secret comes on stdin. An entry that is not there
// exits 3 (Windows' own "not found", 1168); any other failure exits 4.
const WINDOWS_CRED = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PkCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
  public static int Read(string target, out string text) {
    IntPtr ptr; text = null;
    if (!CredRead(target, 1, 0, out ptr)) return Marshal.GetLastWin32Error();
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
    text = Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    CredFree(ptr);
    return 0;
  }
  public static int Delete(string target) {
    return CredDelete(target, 1, 0) ? 0 : Marshal.GetLastWin32Error();
  }
}
"@
$op = $args[0]; $target = $args[1]
if ($op -eq 'set') {
  $secret = [Console]::In.ReadToEnd()
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)
  $c = New-Object PkCred+CREDENTIAL
  $c.Type = 1; $c.TargetName = $target; $c.Persist = 2; $c.UserName = 'primerkit'
  $c.CredentialBlobSize = $bytes.Length
  $c.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
  $ok = [PkCred]::CredWrite([ref]$c, 0)
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
  if (-not $ok) { exit 2 }
} elseif ($op -eq 'get') {
  $text = $null
  $code = [PkCred]::Read($target, [ref]$text)
  if ($code -eq 1168) { exit 3 }
  if ($code -ne 0) { exit 4 }
  [Console]::Out.Write($text)
} elseif ($op -eq 'delete') {
  $code = [PkCred]::Delete($target)
  if ($code -eq 1168) { exit 3 }
  if ($code -ne 0) { exit 4 }
}
`;

const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

// get gives null, and remove gives false, only when the keychain says the entry is not
// there. When the keychain could not be asked at all, both throw, so "no key" is never
// said of a key that may still be kept.
export interface Keychain {
  set(name: string, secret: string): Promise<void>;
  get(name: string): Promise<string | null>;
  remove(name: string): Promise<boolean>;
}

// Each helper is started by its full path. Windows looks for a bare program name in the
// current folder first, so a file named powershell.exe there would run in its place and
// be handed the secret. SystemRoot counts only as a full path with its drive: a value
// such as "." would make the path one under the current folder again.
export function keychainProgram(platform: NodeJS.Platform, env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): string {
  if (platform === 'win32') {
    const root = [env.SystemRoot, env.windir].find((v) => v !== undefined && /^[A-Za-z]:[\\/]/.test(v));
    return join(root ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  if (platform === 'darwin') return '/usr/bin/security';
  return ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool', '/bin/secret-tool'].find((p) => exists(p)) ?? 'secret-tool';
}

const NAME = /^[a-z0-9-]+$/;
// A character that is not printable, such as a line break: macOS's keychain tool would
// read what follows one as a command of its own.
const CONTROL = /[\u0000-\u001f\u007f]/;

// The keychain entry for a name is primerkit/<name>, such as primerkit/alpaca-paper-secret.
export function osKeychain(platform: NodeJS.Platform = process.platform, run: KeyRunner = keyRunner): Keychain {
  const program = keychainProgram(platform);
  // A name goes into a script and a command line, so it is held to letters, digits and hyphens.
  const target = (name: string) => {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a keychain entry name: lower case letters, digits and hyphens`);
    return `primerkit/${name}`;
  };
  const kept = (secret: string) => {
    if (CONTROL.test(secret)) throw new Error('A key cannot hold a line break or another control character.');
    return secret;
  };
  const failed = (what: string, r: { code: number | null; stderr: string }) => new Error(`${what}: ${r.stderr.trim() || `exit ${r.code}`}`);
  if (platform === 'win32') {
    const ps = (op: string, name: string, input = '') => run(program, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(`& { ${WINDOWS_CRED} } ${op} '${target(name)}'`)], input);
    return {
      set: async (name, secret) => {
        const r = await ps('set', name, kept(secret));
        if (r.code !== 0) throw failed(`Credential Manager did not keep ${target(name)}`, r);
      },
      get: async (name) => {
        const r = await ps('get', name);
        if (r.code === 0) return r.stdout;
        if (r.code === 3) return null;
        throw failed(`Credential Manager could not be read for ${target(name)}`, r);
      },
      remove: async (name) => {
        const r = await ps('delete', name);
        if (r.code === 0) return true;
        if (r.code === 3) return false;
        throw failed(`Credential Manager did not remove ${target(name)}`, r);
      },
    };
  }
  if (platform === 'darwin') {
    // security's interactive mode reads its commands, and so the secret, from stdin. It
    // exits 44 where the entry is not there.
    const quote = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`;
    return {
      set: async (name, secret) => {
        const r = await run(program, ['-i'], `add-generic-password -U -a primerkit -s ${quote(target(name))} -w ${quote(kept(secret))}\n`);
        if (r.code !== 0) throw failed(`the keychain did not keep ${target(name)}`, r);
      },
      get: async (name) => {
        const r = await run(program, ['find-generic-password', '-a', 'primerkit', '-s', target(name), '-w'], '');
        if (r.code === 0) return r.stdout.replace(/\n$/, '');
        if (r.code === 44) return null;
        throw failed(`the keychain could not be read for ${target(name)}`, r);
      },
      remove: async (name) => {
        const r = await run(program, ['delete-generic-password', '-a', 'primerkit', '-s', target(name)], '');
        if (r.code === 0) return true;
        if (r.code === 44) return false;
        throw failed(`the keychain did not remove ${target(name)}`, r);
      },
    };
  }
  // The Secret Service, through secret-tool, which reads the secret on stdin. A lookup
  // that finds nothing exits 1 and says nothing; a failure says why.
  const lookup = async (name: string): Promise<string | null> => {
    const entry = target(name);
    const r = await run(program, ['lookup', 'service', 'primerkit', 'name', name], '');
    if (r.code === 0 && r.stdout) return r.stdout;
    if ((r.code === 0 || r.code === 1) && !r.stderr.trim()) return null;
    throw failed(`the Secret Service could not be read for ${entry}`, r);
  };
  return {
    set: async (name, secret) => {
      const r = await run(program, ['store', '--label', target(name), 'service', 'primerkit', 'name', name], kept(secret));
      if (r.code !== 0) throw new Error(`the Secret Service did not keep ${target(name)}: ${r.stderr.trim() || 'is secret-tool installed?'}`);
    },
    get: lookup,
    remove: async (name) => {
      if ((await lookup(name)) === null) return false;
      const r = await run(program, ['clear', 'service', 'primerkit', 'name', name], '');
      if (r.code !== 0) throw failed(`the Secret Service did not remove ${target(name)}`, r);
      return true;
    },
  };
}
