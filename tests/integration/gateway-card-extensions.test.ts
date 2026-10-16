import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    clients: [] as any[],
    managers: [] as any[],
    token: vi.fn(), post: vi.fn(), put: vi.fn(), builtin: vi.fn(), inbound: vi.fn(),
}));
vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'card', TOPIC_ROBOT: 'robot',
    DWClient: class {
        connected = false;
        listeners: Record<string, (res: any) => Promise<void>> = {};
        socketCallBackResponse = vi.fn();
        constructor(public config: any) { shared.clients.push(this); }
        registerCallbackListener(topic: string, cb: any) { this.listeners[topic] = cb; }
        async connect() { this.connected = true; }
        disconnect() { this.connected = false; }
    },
}));
vi.mock('../../src/gateway/connection-manager', () => ({
    ConnectionManager: class {
        connected = false;
        release!: () => void;
        stopped = new Promise<void>(resolve => { this.release = resolve; });
        constructor(public client: any, _id: string, public config: any) { shared.managers.push(this); }
        async connect() { this.connected = true; }
        isConnected() { return this.connected; }
        waitForStop() { return this.stopped; }
        stop() { this.connected = false; this.release(); }
    },
}));
vi.mock('../../src/platform/auth', () => ({ getAccessToken: shared.token }));
vi.mock('../../src/shared/http-client', () => ({ default: { post: shared.post, put: shared.put, isAxiosError: () => false } }));
vi.mock('../../src/card/card-service', () => ({ recoverPendingCardsForAccount: async () => 0, finalizeActiveCardsForAccount: async () => 0 }));
vi.mock('../../src/card/ask-user-question', () => ({ recoverAskUserQuestionsForAccount: async () => 0 }));
vi.mock('../../src/card/card-action-handler', () => ({ handleCardAction: shared.builtin }));
vi.mock('../../src/gateway/inbound-handler', () => ({ handleDingTalkMessage: shared.inbound }));
vi.mock('../../src/shared/utils', async (importOriginal) => ({
    ...await importOriginal<any>(),
    cleanupOrphanedTempFiles: vi.fn(), closePluginDebugLog: vi.fn(),
    resolvePluginDebugLog: ({ baseLog }: any) => baseLog,
}));

import { createDingTalkGateway } from '../../src/gateway/channel-gateway';
import { registerDingTalkCardExtension } from '../../src/card/card-extension-api';
import { createCardExtensionHost } from '../unit/fixtures/card-extension-host';
import { getConfig, resolveDingTalkAccount } from '../../src/platform/config';
import { ConnectionState } from '../../src/platform/types';

const credentials = { clientId: 'nested-app', clientSecret: 'nested-secret' };
const sendInput = { cardId: 'card1', userId: 'owner', templateId: 'template.schema', variables: { title: 'Test' } };
const event = (messageId = 'event1') => ({
    headers: { messageId },
    data: JSON.stringify({ outTrackId: 'ocx1.default.test.card1', userId: 'owner',
        content: { cardPrivateData: { actionIds: ['save'], params: { form: { note: 'private-text' } } } } }),
});
let stops: Array<() => Promise<unknown>>;
let host: ReturnType<typeof createCardExtensionHost>;
beforeEach(() => {
    host = createCardExtensionHost();
    shared.clients = [];
    shared.managers = [];
    stops = [];
    shared.token.mockResolvedValue('test-token');
    shared.post.mockResolvedValue({ status: 200, data: {} });
    shared.put.mockResolvedValue({ status: 200, data: {} });
});
afterEach(async () => { for (const stop of stops) await stop(); });

async function start(onAction = vi.fn(), useConnectionManager = false, nested = false) {
    const config = { ...credentials, useConnectionManager };
    const cfg: any = { channels: { dingtalk: nested ? { accounts: { default: config } } : config } };
    const extension = host.register(() => registerDingTalkCardExtension(host.api() as any, { accountId: 'default', namespace: 'test', onAction }));
    const controller = new AbortController();
    let status: any = {};
    const run = createDingTalkGateway().startAccount!({
        cfg, channelRuntime: host.channelRuntime, account: { accountId: 'default', config: getConfig(cfg, 'default') },
        abortSignal: controller.signal, getStatus: () => status, setStatus: (next: any) => { status = next; },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as any);
    stops.push(async () => { controller.abort(); await run; });
    await vi.waitFor(() => expect(status.connected).toBe(true));
    return { extension, controller, client: shared.clients.at(-1), cfg };
}

describe('card extension gateway regressions', () => {
    it('sends and updates with credentials only in accounts.default', async () => {
        const { extension, cfg } = await start(vi.fn(), false, true);
        expect(resolveDingTalkAccount(cfg)).toMatchObject({ ...credentials, configured: true });
        expect(extension.isReady()).toBe(true);
        await extension.sendCard(sendInput);
        await extension.updateCard({ cardId: 'card1', variables: { title: 'Updated' } });
        expect(shared.token).toHaveBeenCalledWith(expect.objectContaining(credentials), expect.anything());
        expect(shared.post).toHaveBeenCalledOnce();
        expect(shared.put).toHaveBeenCalledOnce();
    });

    it('ACKs before invoking a slow handler and deduplicates pending and completed delivery', async () => {
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        let client: any;
        const handler = vi.fn(() => {
            expect(client.socketCallBackResponse).toHaveBeenCalledWith('event1', { success: true });
            return pending;
        });
        ({ client } = await start(handler));
        const first = client.listeners.card(event());
        try {
            expect(client.socketCallBackResponse).toHaveBeenCalledOnce();
            await client.listeners.card(event());
            expect(handler).toHaveBeenCalledOnce();
            expect(client.socketCallBackResponse).toHaveBeenCalledTimes(2);
        } finally { finish(); await first; }
        await client.listeners.card(event());
        expect(handler).toHaveBeenCalledOnce();
        expect(client.socketCallBackResponse).toHaveBeenCalledTimes(3);
        expect(shared.builtin).not.toHaveBeenCalled();
        expect(shared.inbound).not.toHaveBeenCalled();
    });

    it('ACKs each delivery and releases a throwing handler for retry', async () => {
        const handler = vi.fn(() => { throw new Error('private-text'); });
        const { client } = await start(handler);
        await client.listeners.card(event());
        await client.listeners.card(event());
        expect(handler).toHaveBeenCalledTimes(2);
        expect(client.socketCallBackResponse).toHaveBeenCalledTimes(2);
        expect(shared.builtin).not.toHaveBeenCalled();
    });

    it('tracks native disconnect/reconnect directly from SDK state and rejects sends while down', async () => {
        const { extension, client, controller } = await start();
        expect(extension.isReady()).toBe(true);
        client.connected = false; // Native SDK does not emit a client-level close event.
        expect(extension.isReady()).toBe(false);
        await expect(extension.sendCard(sendInput)).rejects.toMatchObject({ code: 'not-connected' });
        await expect(extension.updateCard({ cardId: 'card1', variables: { title: 'Test' } })).rejects.toMatchObject({ code: 'not-connected' });
        expect(shared.token).not.toHaveBeenCalled();
        expect(shared.post).not.toHaveBeenCalled();
        expect(shared.put).not.toHaveBeenCalled();
        client.connected = true;
        expect(extension.isReady()).toBe(true);
        await extension.sendCard(sendInput);
        controller.abort();
        client.connected = true; // A late SDK notification must not revive a stopped transport.
        expect(extension.isReady()).toBe(false);
    });

    it('keeps managed reconnect readiness tied to the connection manager', async () => {
        const { extension } = await start(vi.fn(), true);
        const manager = shared.managers[0];
        expect(extension.isReady()).toBe(true);
        manager.config.onStateChange(ConnectionState.DISCONNECTED);
        expect(extension.isReady()).toBe(false);
        manager.config.onStateChange(ConnectionState.CONNECTED);
        expect(extension.isReady()).toBe(true);
    });
});
