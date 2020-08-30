import * as R from 'ramda';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import mockCard from './mockCard';

// ENVIRONMENT
declare const USERNAME: string;
declare const PWD: string;
declare const MOCK_API: string;
declare const ZHIWEI_DOMAIN: string;
declare const SENTRY_LARK_WEBHOOK: string;

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 处理 sentry webhook
 * 向知微tkb的缺陷卡片建立对应的缺陷卡
 */
export async function handleRequest(request: Request, event: FetchEvent): Promise<Response> {
    const { method, headers } = request;
    const contentType = headers.get('content-type') ?? '';
    await logToMock(`request coming`);
    if (method === 'POST' && /application\/json/.test(contentType)) {
        try {
            const payload = await request.json();
            event.waitUntil(workflow({ payload }));
            return new Response('ok', { status: 200 });
        } catch (error) {
            await logToMock(error.message);
        }
    }
    return new Response(undefined, { status: 405 });
}

function logToMock(message: string) {
    return fetch(MOCK_API, {
        method: 'POST',
        body: message
    });
}

async function workflow(opt: { payload: any }) {
    await logToMock('worker work flow start');
    const jSession = await getSession();
    await createCard({
        sentryBody: opt.payload,
        cookies: jSession
    });
}

const getShareUrl = (cardId: string) => `${ZHIWEI_DOMAIN}/#/?viewId=whole&vuId=${cardId}`;

function login() {
    return fetch(`${ZHIWEI_DOMAIN}/login`, {
        headers: {
            accept: 'application/json',
            code: '',
            'content-type': 'application/json;charset=UTF-8',
            flag: 'json'
        },
        body: `{"username": "${USERNAME}","password":"${PWD}"}`,
        method: 'POST'
    });
}

async function getSession() {
    try {
        const loginRes = await login();
        await logToMock(`login result, ${loginRes.status}`);
        return loginRes.headers.get('set-cookie') ?? '';
    } catch (error) {
        await logToMock(error.message);
        return '';
    }
}

async function createCard({
    sentryBody,
    cookies
}: {
    cookies: string;
    sentryBody: { message: string; url: string; event: any };
}) {
    try {
        const {
            event: { title },
            url
        } = sentryBody;

        const payload = {
            ...mockCard,
            name: R.when(R.anyPass([R.isNil, R.isEmpty]), R.always('sentry report error'), title),
            desc: url,
            descHtml: `<p>sentry: <a href="${url}">${url}</a></p>`
        };

        await logToMock(JSON.stringify({ message: 'create card', payload, sentryBody }));

        const res = await fetch(`${ZHIWEI_DOMAIN}/api/v1/view/c311089eef2b496b84560aa08f099cc0/vu`, {
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                Cookie: cookies
            },
            body: JSON.stringify(payload),
            method: 'POST'
        });
        if (res.ok !== true) {
            throw new Error(`创建卡片失败: ${res.statusText}`);
        }

        const response = await res.json();
        const cardInfo: { id: string; code: string } = response.resultValue;

        await Promise.allSettled([
            logToMock(JSON.stringify({ message: 'card detail', cardInfo })),
            sendToLarkSentryBot(cardInfo, sentryBody)
        ]);
    } catch ({ message }) {
        await logToMock(`create card error: ${message}`);
    }
}

async function sendToLarkSentryBot(
    { id, code }: { id: string; code: string },
    sentryBody: { message: string; url: string; event: any }
) {
    const prependCardCode = R.replace(/^/, `#${code} `);
    const hackBody = R.evolve(
        {
            event: {
                title: prependCardCode
            },
            url: R.always(getShareUrl(id))
        },
        sentryBody
    );
    try {
        const response = await fetch(SENTRY_LARK_WEBHOOK, {
            method: 'POST',
            body: JSON.stringify(hackBody),
            headers: {
                'content-type': 'application/json'
            }
        });
        if (response.ok !== true) {
            throw new Error('send To Lark Sentry Bot error');
        }
    } catch ({ message }) {
        await logToMock(`send to lark error: ${message}`);
    }
}
