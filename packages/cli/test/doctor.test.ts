import { describe, expect, it } from 'vitest';
import { runtimeLists } from '../src/terminal';

describe('the doctor', () => {
  it('finds a model in the runtime list by its whole name, never as part of another', () => {
    const tags = JSON.stringify({ models: [{ name: 'qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' }, { name: 'llama3.1:latest', model: 'llama3.1:latest' }] });
    expect(runtimeLists(tags, 'qwen2.5:7b')).toBe(false);
    expect(runtimeLists(tags, 'qwen2.5:7b-instruct')).toBe(true);
    // Ollama's ":latest" is the name without it.
    expect(runtimeLists(tags, 'llama3.1')).toBe(true);
    expect(runtimeLists(tags, 'llama3.1:latest')).toBe(true);
    // An OpenAI-compatible server's list.
    const models = JSON.stringify({ data: [{ id: 'gpt-oss-20b' }] });
    expect(runtimeLists(models, 'gpt-oss-20b')).toBe(true);
    expect(runtimeLists(models, 'gpt-oss')).toBe(false);
    expect(runtimeLists('not json', 'gpt-oss-20b')).toBe(false);
  });
});
