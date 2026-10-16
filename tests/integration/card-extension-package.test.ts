import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Build isolated artifacts: never clear dist while another test or a live Gateway uses it.
describe('public card extension package entry', () => {
    it('keeps host SDK external across separately bundled consumers and follows host registry reloads', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'card-extension-package-'));
        try {
            const pkg = join(dir, 'node_modules/@soimy/dingtalk');
            mkdirSync(join(pkg, 'dist'), { recursive: true });
            symlinkSync(realpathSync(resolve('node_modules/openclaw')), join(dir, 'node_modules/openclaw'));
            cpSync(resolve('package.json'), join(pkg, 'package.json'));
            const buildOptions = { bundle: true, platform: 'node' as const, format: 'esm' as const, logLevel: 'silent' as const, external: ['openclaw', 'openclaw/*'] };
            const built = await build({ ...buildOptions, entryPoints: ['src/card/card-extension-api.ts'], outfile: join(pkg, 'dist/card-extensions.js'), metafile: true });
            expect(Object.keys(built.metafile.inputs).some(path => path.includes('node_modules/openclaw/'))).toBe(false);
            const imports = Object.values(built.metafile.outputs).flatMap(output => output.imports);
            expect(imports).toEqual(expect.arrayContaining([
                expect.objectContaining({ path: 'openclaw/plugin-sdk/plugin-runtime', external: true }),
                expect.objectContaining({ path: 'openclaw/plugin-sdk/channel-runtime-context', external: true }),
            ]));
            const tsc = resolve('node_modules/typescript/bin/tsc');
            writeFileSync(join(dir, 'declarations.json'), JSON.stringify({
                compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
                    declaration: true, emitDeclarationOnly: true, strict: true, skipLibCheck: true, types: [],
                    rootDir: resolve('.'), outDir: join(pkg, 'dist') },
                files: [resolve('src/card/card-extension-api.ts')],
            }));
            execFileSync(process.execPath, [tsc, '-p', join(dir, 'declarations.json')], { encoding: 'utf8' });
            writeFileSync(join(dir, 'consumer.mts'), `
import { registerDingTalkCardExtension, type DingTalkCardAction } from '@soimy/dingtalk/card-extensions';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
declare const api: OpenClawPluginApi;
const handler = (action: DingTalkCardAction) => {
  const user: string = action.userId; void user;
  // @ts-expect-error Wire identity is not part of the public action contract.
  void action.outTrackId;
  // @ts-expect-error Registration scope is not duplicated on public actions.
  void action.accountId;
};
const extension = registerDingTalkCardExtension(api, { accountId: 'main', namespace: 'demo', onAction: handler });
const ready: boolean = extension.isReady(); void ready;
const result: Promise<void> = extension.sendCard({ cardId: 'one', userId: 'owner', templateId: 'test.schema', variables: { title: 'Hello' } });
void result;
// @ts-expect-error Lifecycle belongs to the host registry.
extension.dispose();
// @ts-expect-error Readiness is the sole public status surface.
extension.getStatus();
`);
            writeFileSync(join(dir, 'consumer-tsconfig.json'), JSON.stringify({
                compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
                    strict: true, skipLibCheck: true, noEmit: true, types: [] },
                files: ['consumer.mts'],
            }));
            execFileSync(process.execPath, [tsc, '-p', join(dir, 'consumer-tsconfig.json')], { encoding: 'utf8' });
            const code = readFileSync(join(pkg, 'dist/card-extensions.js'), 'utf8');
            expect(code).not.toMatch(/from ["'](?:axios|dingtalk-stream)/);
            expect(code).not.toContain('openclaw.dingtalk.card-extensions');
            await build({ ...buildOptions, entryPoints: ['tests/unit/fixtures/card-extension-host.ts'], outfile: join(dir, 'provider.mjs') });
            await build({ ...buildOptions, entryPoints: ['src/card/card-extension-api.ts'], outfile: join(dir, 'consumer-copy.mjs') });
            await build({ ...buildOptions, entryPoints: ['src/card/card-extension-callback.ts'], outfile: join(dir, 'callback.mjs') });
            writeFileSync(join(dir, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { registerDingTalkCardExtension as register } from '@soimy/dingtalk/card-extensions';
import { registerDingTalkCardExtension as copy } from './consumer-copy.mjs';
import { createCardExtensionHost } from './provider.mjs';
import { dispatchCardExtensionCallback as dispatch } from './callback.mjs';
const host = createCardExtensionHost();
let observed;
const extension = host.register(() => register(host.api(), { accountId: 'main', namespace: 'demo', onAction: action => { observed = action; } }));
assert.equal(extension.isReady(), false);
let delivered;
const lease = host.bind('main', { isConnected: () => true, send: async input => { delivered = input; }, update: async () => {} });
assert.equal(extension.isReady(), true);
assert.throws(() => host.register(() => copy(host.api(), { accountId: 'main', namespace: 'demo', onAction() {} })), { code: 'namespace-conflict' });
assert.equal(await extension.sendCard({ cardId: 'one', userId: 'owner', templateId: 'test.schema', variables: { title: 'Hello' } }), undefined);
assert.equal(delivered.outTrackId, 'ocx1.main.demo.one');
const callback = { accountId: 'main', payload: { outTrackId: delivered.outTrackId, userId: 'owner', content: { cardPrivateData: { actionIds: ['save'] } } } };
await dispatch(callback);
assert.equal(observed.userId, 'owner');
assert.equal('outTrackId' in observed, false);
host.reload();
observed = undefined;
await dispatch(callback);
assert.equal(observed, undefined);
host.register(() => copy(host.api(), { accountId: 'main', namespace: 'demo', onAction: action => { observed = action; } }));
await dispatch(callback);
assert.equal(observed.cardId, 'one');
lease.dispose();
assert.equal(extension.isReady(), false);
process.stdout.write('standalone consumer passed');
`);
            expect(execFileSync(process.execPath, [join(dir, 'consumer.mjs')], { cwd: dir, encoding: 'utf8' })).toBe('standalone consumer passed');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);
});
