// The website's service as one Lambda function behind API Gateway, which has already checked the
// sign-in: every request arrives with the claims of whoever sent it.
import { db, files, users } from './aws.mjs';
import { createRouter, createService, Problem } from './service.mjs';

const route = createRouter(createService({ db, files, users }));

const answer = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export async function handler(event) {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims?.sub) return answer(401, { error: 'account.signedOut' });
  const user = { id: claims.sub, name: claims.name || claims.email, email: claims.email };
  // The site reaches this through its own address, under /api.
  try {
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};
    return answer(200, await route(user, event.requestContext.http.method, event.rawPath.replace(/^\/api/, ''), body, event.queryStringParameters ?? {}));
  } catch (err) {
    if (err instanceof Problem) return answer(err.status, { error: err.message });
    console.error(err);
    return answer(500, { error: 'error.notSaved' });
  }
}
