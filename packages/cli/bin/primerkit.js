#!/usr/bin/env node
// This slice runs its TypeScript source through tsx. A build step comes before any
// release.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
