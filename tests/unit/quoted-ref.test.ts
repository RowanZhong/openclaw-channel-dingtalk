import { describe, expect, it } from 'vitest';

import { upsertInboundMessageContext, resolveByMsgId } from '../../src/messaging/message-context-store';
import { buildInboundQuotedRef } from '../../src/messaging/quoted-ref';

describe('quoted-ref', () => {
    it('does not build an outbound quotedRef without a stable key or createdAt fallback', () => {
        const quotedRef = buildInboundQuotedRef(
            {
                msgId: 'reply_msg_1',
                msgtype: 'text',
                createAt: 1700000000000,
                chatbotUserId: 'bot_1',
                text: {
                    content: 'reply body',
                    isReplyMsg: true,
                    repliedMsg: {
                        msgId: 'quoted_bot_msg_1',
                        senderId: 'bot_1',
                    },
                },
            } as any,
            {
                text: 'reply body',
                messageType: 'text',
                quoted: {
                    msgId: 'quoted_bot_msg_1',
                    isQuotedCard: true,
                },
            },
        );

        expect(quotedRef).toBeUndefined();
    });

    it('drops invalid quotedRef payloads when persisting message context', () => {
        upsertInboundMessageContext({
            accountId: 'main',
            conversationId: 'cid_invalid_quote',
            msgId: 'msg_invalid_quote_1',
            createdAt: 1700000000000,
            messageType: 'text',
            text: 'hello',
            topic: null,
            quotedRef: {
                targetDirection: 'outbound',
            } as any,
        });

        expect(resolveByMsgId({
            accountId: 'main',
            conversationId: 'cid_invalid_quote',
            msgId: 'msg_invalid_quote_1',
        })?.quotedRef).toBeUndefined();
    });
});
