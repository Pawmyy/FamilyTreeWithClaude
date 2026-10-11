// The website's front door: signing in, choosing which record to open, and the menu for sharing a
// record and seeing who is in it. Everything here is drawn by this file, over the page.
//
// Sign-in is Amazon Cognito's, asked directly: an email, a password, and a code sent once to the email.
import { t } from '../public/i18n.js';
import { CLIENT_ID, REGION } from './cloud.config.js';

// Cognito's refusals, as texts of ours.
const REFUSALS = {
  NotAuthorizedException: 'account.wrongPassword',
  UserNotFoundException: 'account.wrongPassword',
  UsernameExistsException: 'account.emailTaken',
  InvalidPasswordException: 'account.weakPassword',
  InvalidParameterException: 'account.checkFields',
  CodeMismatchException: 'account.wrongCode',
  ExpiredCodeException: 'account.wrongCode',
  LimitExceededException: 'account.tooMany',
  TooManyRequestsException: 'account.tooMany',
};

async function cognito(action, body) {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.' + action },
    body: JSON.stringify({ ClientId: CLIENT_ID, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(REFUSALS[data.__type] ?? 'account.failed'), { type: data.__type });
  return data;
}

// Staying signed in between visits; private browsing may refuse, which means signing in each time.
const kept = {
  get: (key) => { try { return localStorage.getItem('account.' + key); } catch { return null; } },
  set: (key, value) => { try { value === null ? localStorage.removeItem('account.' + key) : localStorage.setItem('account.' + key, value); } catch { /* not kept */ } },
};
let token = null;
let tokenUntil = 0;

function signedIn({ AuthenticationResult: result }) {
  token = result.IdToken;
  tokenUntil = Date.now() + result.ExpiresIn * 1000;
  if (result.RefreshToken) kept.set('refresh', result.RefreshToken);
}

async function idToken() {
  if (token && Date.now() < tokenUntil - 60_000) return token;
  const refresh = kept.get('refresh');
  if (!refresh) throw new Error('account.signedOut');
  try {
    signedIn(await cognito('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: refresh } }));
  } catch {
    throw new Error('account.signedOut');
  }
  return token;
}

// Ask the website's service, as whoever is signed in.
export async function call(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: { authorization: 'Bearer ' + await idToken(), 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'account.signedOut' : data.error ?? 'error.notSaved');
  return data;
}

// ---- Drawing ----

// h('button', { class: 'ghost', text: 'account.signIn', onclick }) -> a button whose words follow the language.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'text') Object.assign(node, { textContent: t(value) }).dataset.i18n = value;
    else if (name === 'hint') Object.assign(node, { placeholder: t(value) }).dataset.i18nPlaceholder = value;
    else if (name === 'class') node.className = value;
    else node[name] = value;
  }
  node.append(...children.filter(Boolean));
  return node;
}

const field = (label, props) => {
  const input = h('input', props);
  return { input, row: h('label', {}, h('span', { text: label }), input) };
};

const door = h('div', { id: 'account', hidden: true });
document.body.append(door);

// One screen of the front door: a heading, what to fill in, and a place for what went wrong.
function screen(title, ...parts) {
  const problem = h('p', { class: 'problem', hidden: true });
  door.replaceChildren(h('form', { class: 'card', onsubmit: (evt) => evt.preventDefault() }, h('h1', { text: 'account.app' }), h('h2', { text: title }), ...parts, problem));
  door.hidden = false;
  door.querySelector('input')?.focus();
  // Run something a button asked for, saying what went wrong if it fails.
  return (work) => async () => {
    problem.hidden = true;
    for (const b of door.querySelectorAll('button')) b.disabled = true;
    try {
      await work();
    } catch (err) {
      problem.textContent = t(err.message);
      problem.hidden = false;
    } finally {
      for (const b of door.querySelectorAll('button')) b.disabled = false;
    }
  };
}

// Ask before something that cannot be taken back.
function ask(text, yes) {
  const box = h('dialog', { class: 'ask' }, h('p', { textContent: text }),
    h('div', { class: 'answers' }, h('button', { class: 'ghost', text: 'confirm.no', onclick: () => box.close() }), h('button', { class: 'sure', text: yes, onclick: () => box.close('yes') })));
  document.body.append(box);
  box.showModal();
  return new Promise((resolve) => {
    box.onclose = () => {
      box.remove();
      resolve(box.returnValue === 'yes');
    };
  });
}

// ---- Signing in ----

// Each of these resolves once someone is signed in.
function signIn(email = '') {
  return new Promise((done) => {
    const mail = field('account.email', { type: 'email', autocomplete: 'username', value: email, required: true });
    const pass = field('account.password', { type: 'password', autocomplete: 'current-password', required: true });
    const run = screen('account.signInTitle', mail.row, pass.row,
      h('button', { text: 'account.signIn', onclick: () => go() }),
      h('button', { type: 'button', class: 'ghost', text: 'account.toSignUp', onclick: () => done(signUp()) }),
      h('button', { type: 'button', class: 'link', text: 'account.toForgot', onclick: () => done(forgot(mail.input.value)) }));
    const go = run(async () => {
      try {
        signedIn(await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: mail.input.value.trim(), PASSWORD: pass.input.value } }));
      } catch (err) {
        // The email was never confirmed: pick up where signing up left off.
        if (err.type === 'UserNotConfirmedException') return done(confirm(mail.input.value.trim(), pass.input.value));
        throw err;
      }
      done();
    });
  });
}

function signUp() {
  return new Promise((done) => {
    const name = field('account.name', { autocomplete: 'name', required: true });
    const mail = field('account.email', { type: 'email', autocomplete: 'username', required: true });
    const pass = field('account.newPassword', { type: 'password', autocomplete: 'new-password', required: true, minLength: 8 });
    const run = screen('account.signUpTitle', name.row, mail.row, pass.row,
      h('button', { text: 'account.signUp', onclick: () => go() }),
      h('button', { type: 'button', class: 'link', text: 'account.toSignIn', onclick: () => done(signIn()) }));
    const go = run(async () => {
      if (!name.input.value.trim() || !mail.input.value.trim()) throw new Error('account.checkFields');
      const email = mail.input.value.trim();
      await cognito('SignUp', { Username: email, Password: pass.input.value, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: name.input.value.trim() }] });
      done(confirm(email, pass.input.value));
    });
  });
}

// The code sent to a new account's email. With the password still in hand, they are signed straight in.
function confirm(email, password) {
  return new Promise((done) => {
    const code = field('account.code', { inputMode: 'numeric', autocomplete: 'one-time-code', required: true });
    const run = screen('account.confirmTitle', h('p', { class: 'hint', textContent: t('account.codeSent', { email }) }), code.row,
      h('button', { text: 'account.confirm', onclick: () => go() }),
      h('button', { type: 'button', class: 'link', text: 'account.resend', onclick: () => again() }));
    const go = run(async () => {
      await cognito('ConfirmSignUp', { Username: email, ConfirmationCode: code.input.value.trim() });
      signedIn(await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
      done();
    });
    const again = run(() => cognito('ResendConfirmationCode', { Username: email }));
  });
}

function forgot(email = '') {
  return new Promise((done) => {
    const mail = field('account.email', { type: 'email', autocomplete: 'username', value: email, required: true });
    const run = screen('account.forgotTitle', mail.row,
      h('button', { text: 'account.sendCode', onclick: () => go() }),
      h('button', { type: 'button', class: 'link', text: 'account.toSignIn', onclick: () => done(signIn(mail.input.value)) }));
    const go = run(async () => {
      const address = mail.input.value.trim();
      await cognito('ForgotPassword', { Username: address });
      const code = field('account.code', { inputMode: 'numeric', autocomplete: 'one-time-code', required: true });
      const pass = field('account.newPassword', { type: 'password', autocomplete: 'new-password', required: true, minLength: 8 });
      const set = screen('account.forgotTitle', h('p', { class: 'hint', textContent: t('account.codeSent', { email: address }) }), code.row, pass.row,
        h('button', { text: 'account.setPassword', onclick: () => change() }));
      const change = set(async () => {
        await cognito('ConfirmForgotPassword', { Username: address, ConfirmationCode: code.input.value.trim(), Password: pass.input.value });
        signedIn(await cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: address, PASSWORD: pass.input.value } }));
        done();
      });
    });
  });
}

function signOut() {
  kept.set('refresh', null);
  location.reload();
}

// ---- Choosing a record ----

// Resolves to the id of the record to open: one of theirs, a new one, or one they have a code for.
function choose(me) {
  return new Promise((done) => {
    const code = field('account.enterCode', { hint: 'account.codeHint', autocomplete: 'off' });
    const run = screen('account.chooseTitle',
      ...me.records.map((record) => h('button', { type: 'button', class: 'ghost', textContent: t('account.recordOf', { names: record.members.join(', ') }), onclick: () => done(record.id) })),
      h('button', { type: 'button', text: 'account.start', onclick: () => fresh() }),
      code.row,
      h('button', { type: 'button', class: 'ghost', text: 'account.join', onclick: () => join() }),
      h('p', { class: 'hint', textContent: t('account.signedInAs', me) }),
      h('button', { type: 'button', class: 'link', text: 'account.signOut', onclick: signOut }));
    const fresh = run(async () => done((await call('POST', 'records')).id));
    const join = run(async () => done((await call('POST', 'join', { code: code.input.value })).id));
  });
}

// Sign in if need be, then open the record they had open last, or ask which.
// Resolves to { record, name } once the page can go ahead.
export async function enter() {
  let me;
  try {
    me = await call('GET', 'me');
  } catch {
    await signIn(kept.get('email') ?? '');
    me = await call('GET', 'me');
  }
  kept.set('email', me.email);
  // Coming back from "another record" means being asked, even with one open last.
  const asked = sessionStorage.getItem('account.choose');
  sessionStorage.removeItem('account.choose');
  const record = !asked && me.records.some((r) => r.id === me.last) ? me.last : await choose(me);
  door.hidden = true;
  door.replaceChildren();
  addMenu(record, me);
  return { record, name: me.name };
}

function chooseAgain() {
  sessionStorage.setItem('account.choose', 'yes');
  location.reload();
}

// The record can no longer be read: signed out elsewhere, or taken out of it by another member.
let leaving = false;
export function lost(err) {
  if (leaving || !['account.notMember', 'account.signedOut'].includes(err.message)) return;
  leaving = true;
  alert(t(err.message));
  chooseAgain();
}

// ---- The menu: sharing the record, its members, and the account ----

function addMenu(record, me) {
  const box = h('dialog', { id: 'accountMenu' });
  document.body.append(box);
  const open = h('button', { class: 'ghost', textContent: '👤', title: t('account.menu'), onclick: () => show() });
  document.getElementById('themeSwitch').after(open);

  // Do something to the record, then draw the menu again; say what went wrong in the menu itself.
  const then = (work) => async () => {
    try {
      if (await work() !== false) await show();
    } catch (err) {
      box.querySelector('.problem').textContent = t(err.message);
      box.querySelector('.problem').hidden = false;
    }
  };

  async function show() {
    const { code, members } = await call('GET', `records/${record}`);
    const remove = (member) => then(async () => {
      const self = member.id === me.id;
      const last = members.length === 1;
      if (!await ask(t(self ? (last ? 'account.askLeaveLast' : 'account.askLeave') : 'account.askRemove', member), self ? 'account.leave' : 'account.remove')) return false;
      await call('DELETE', `records/${record}/members/${member.id}`);
      if (self) chooseAgain();
      return !self;
    });
    box.replaceChildren(
      h('h2', { text: 'account.shareTitle' }),
      code
        ? h('div', { class: 'share' }, h('output', { textContent: code }),
          h('button', { class: 'ghost', text: 'account.copy', onclick: () => navigator.clipboard?.writeText(code) }))
        : h('button', { text: 'account.getCode', onclick: then(() => call('POST', `records/${record}/code`)) }),
      h('p', { class: 'hint', text: code ? 'account.codeAbout' : 'account.noCode' }),
      code && h('button', { class: 'ghost', text: 'account.replaceCode', onclick: then(async () => (await ask(t('account.askReplace'), 'account.replaceCode')) && call('POST', `records/${record}/code`, { replace: true })) }),

      h('h2', { text: 'account.members' }),
      h('ul', { class: 'rows' }, ...members.map((member) => h('li', {},
        h('span', { textContent: `${member.name} · ${member.email}` }),
        h('button', { class: 'danger', text: member.id === me.id ? 'account.leave' : 'account.remove', onclick: remove(member) })))),
      h('p', { class: 'hint', text: 'account.equal' }),

      h('h2', { text: 'account.mine' }),
      h('p', { class: 'hint', textContent: t('account.signedInAs', me) }),
      h('button', { class: 'ghost', text: 'account.another', onclick: chooseAgain }),
      h('button', { class: 'ghost', text: 'account.signOut', onclick: signOut }),
      h('button', { class: 'danger', text: 'account.delete', onclick: then(async () => {
        if (!await ask(t('account.askDelete'), 'account.delete')) return false;
        await call('DELETE', 'me');
        signOut();
      }) }),
      h('p', { class: 'problem', hidden: true }),
      h('button', { text: 'record.closeFile', onclick: () => box.close() }),
    );
    if (!box.open) box.showModal();
  }
}
