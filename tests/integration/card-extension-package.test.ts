import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Build isolated artifacts: never clear dist while another test or a live Gateway uses it.
describe('public card extension package entry', () => {
    it('loads from an independently installed package and shares state with a separately bundled provider', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'card-extension-package-'));
        try {
            const pkg = join(dir, 'node_modules/@soimy/dingtalk');
            mkdirSync(join(pkg, 'dist'), { recursive: true });
            cpSync(resolve('package.json'), join(pkg, 'package.json'));
            await build({ entryPoints: ['src/card/card-extension-api.ts'], outfile: join(pkg, 'dist/card-extensions.js'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
            const tsc = resolve('node_modules/typescript/bin/tsc');
            writeFileSync(join(dir, 'declarations.json'), JSON.stringify({
                compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
                    declaration: true, emitDeclarationOnly: true, strict: true, types: [],
                    rootDir: resolve('.'), outDir: join(pkg, 'dist') },
                files: [resolve('src/card/card-extension-api.ts')],
            }));
            execFileSync(process.execPath, [tsc, '-p', join(dir, 'declarations.json')], { encoding: 'utf8' });
            writeFileSync(join(dir, 'consumer.mts'), `
import { registerDingTalkCardExtension, type DingTalkCardAction } from '@soimy/dingtalk/card-extensions';
const handler = (action: DingTalkCardAction) => { const user: string = action.userId; void user; };
const extension = registerDingTalkCardExtension({ accountId: 'main', namespace: 'demo', onAction: handler });
void extension.getStatus();
`);
            writeFileSync(join(dir, 'consumer-tsconfig.json'), JSON.stringify({
                compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
                    strict: true, skipLibCheck: false, noEmit: true, types: [] },
                files: ['consumer.mts'],
            }));
            execFileSync(process.execPath, [tsc, '-p', join(dir, 'consumer-tsconfig.json')], { encoding: 'utf8' });
            const code = readFileSync(join(pkg, 'dist/card-extensions.js'), 'utf8');
            expect(code).not.toMatch(/from ["'](?:openclaw|axios|dingtalk-stream)/);
            await build({ entryPoints: ['src/card/card-extension-registry.ts'], outfile: join(dir, 'provider.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
            // An independently bundled consumer must see the provider and reject a
            // namespace already registered via the installed public entry.
            await build({ entryPoints: ['src/card/card-extension-api.ts'], outfile: join(dir, 'consumer-copy.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
            writeFileSync(join(dir, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { registerDingTalkCardExtension as register } from '@soimy/dingtalk/card-extensions';
import { registerDingTalkCardExtension as copy } from './consumer-copy.mjs';
import { getCardExtensionRegistry, bindCardExtensionTransport, resolveCardExtensionHandler } from './provider.mjs';
let observed;
const extension = register({ accountId: 'main', namespace: 'demo', onAction: action => { observed = action; } });
assert.equal(extension.getStatus(), 'unavailable');
getCardExtensionRegistry().accountStatus = () => 'configured';
let delivered;
bindCardExtensionTransport('main', { isConnected: () => true, send: async input => { delivered = input; }, update: async () => {} });
assert.equal(extension.getStatus(), 'ready');
assert.throws(() => copy({ accountId: 'main', namespace: 'demo', onAction() {} }), { code: 'namespace-conflict' });
await extension.sendCard({ cardId: 'one', userId: 'owner', templateId: 'test.schema', variables: { title: 'Hello' } });
assert.equal(delivered.outTrackId, 'ocx1.main.demo.one');
await resolveCardExtensionHandler('main', 'demo')({ userId: 'owner' });
assert.equal(observed.userId, 'owner');
extension.dispose();
assert.equal(resolveCardExtensionHandler('main', 'demo'), undefined);
process.stdout.write('standalone consumer passed');
`);
            expect(execFileSync(process.execPath, [join(dir, 'consumer.mjs')], { cwd: dir, encoding: 'utf8' })).toBe('standalone consumer passed');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
