import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), token: vi.fn() }));
vi.mock('../../src/platform/auth', () => ({ getAccessToken: mocks.token }));
vi.mock('../../src/shared/http-client', () => ({ default: { post: mocks.post, put: mocks.put, isAxiosError: (err: any) => err?.isAxiosError === true } }));
import { createCardExtensionTransport } from '../../src/card/card-extension-service';

const input = { cardId: 'c1', outTrackId: 'ocx1.main.example.c1', templateId: 'example.schema', userId: 'user1', variables: { title: 'Private text' } };
const config = { clientId: 'app-key', clientSecret: 'secret', bypassProxyForSend: true };
const transport = () => createCardExtensionTransport({ config, isConnected: () => true });
beforeEach(() => {
    mocks.token.mockResolvedValue('test-token');
    mocks.post.mockResolvedValue({ status: 200, data: { result: { deliverResults: [{ success: true }] } } });
    mocks.put.mockResolvedValue({ status: 200, data: {} });
});

describe('card extension transport', () => {
    it('creates a non-forwardable private card using configured robot and cached token helper', async () => {
        await transport().send(input);
        expect(mocks.token).toHaveBeenCalledWith(config, undefined);
        expect(mocks.post).toHaveBeenCalledWith('https://api.dingtalk.com/v1.0/card/instances/createAndDeliver', {
            outTrackId: input.outTrackId, cardTemplateId: input.templateId, cardData: { cardParamMap: input.variables },
            callbackType: 'STREAM', userIdType: 1, openSpaceId: 'dtv1.card//IM_ROBOT.user1',
            imRobotOpenSpaceModel: { supportForward: false },
            imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode: 'app-key' },
        }, expect.objectContaining({ timeout: 15000, proxy: false, headers: { 'x-acs-dingtalk-access-token': 'test-token', 'Content-Type': 'application/json' } }));
    });
    it('updates by key without creating or delivering another card', async () => {
        await transport().update(input);
        expect(mocks.put).toHaveBeenCalledWith('https://api.dingtalk.com/v1.0/card/instances', {
            outTrackId: input.outTrackId, cardData: { cardParamMap: input.variables }, cardUpdateOptions: { updateCardDataByKey: true },
        }, expect.anything());
        expect(mocks.post).not.toHaveBeenCalled();
    });
    it.each([
        { success: false }, { result: { deliverResults: [{ success: false }] } },
    ])('rejects failed API/delivery results %j', async (data) => {
        mocks.post.mockResolvedValue({ status: 200, data });
        await expect(transport().send(input)).rejects.toMatchObject({ code: 'request-failed' });
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });
    it('does not retry an uncertain create or leak request/response contents', async () => {
        mocks.post.mockRejectedValue({ isAxiosError: true, response: { status: 503, data: 'sensitive' }, config: { headers: { token: 'secret' } }, message: 'Private text' });
        await expect(transport().send(input)).rejects.toMatchObject({ code: 'request-failed', message: 'DingTalk card request failed (HTTP 503)' });
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });
    it('does not create after update failure', async () => {
        mocks.put.mockRejectedValue(new Error('private'));
        await expect(transport().update(input)).rejects.toMatchObject({ code: 'request-failed' });
        expect(mocks.post).not.toHaveBeenCalled();
    });
    it('rechecks connectivity after token resolution', async () => {
        let connected = true;
        mocks.token.mockImplementation(async () => { connected = false; return 'token'; });
        const service = createCardExtensionTransport({ config, isConnected: () => connected });
        await expect(service.send(input)).rejects.toMatchObject({ code: 'not-connected' });
        expect(mocks.post).not.toHaveBeenCalled();
    });
    it('does not expose token resolution errors', async () => {
        mocks.token.mockRejectedValue(new Error('secret from token response'));
        await expect(transport().send(input)).rejects.toMatchObject({ code: 'request-failed', message: 'DingTalk card request failed' });
    });
});
