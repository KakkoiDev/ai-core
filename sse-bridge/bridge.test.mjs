import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createBridgeServer } from './server.mjs';
import { connectAgentBridge } from './host.mjs';

test('joins a terminal guest, streams a request, and registers tools', { timeout: 10000 }, async t => {
  const server = createBridgeServer({
    createLiveSession({ room, onAvailability, onAIRequest, setProject }) {
      room.onPeerJoin(() => room.send('read', null));
      room.onMessage('state', project => {
        setProject(project);
        onAvailability(true);
      });
      room.onMessage('ask', onAIRequest);
      return { registerAgent: async () => ({ ok: true }), stop() {} };
    },
    registerTools(editor, context) {
      context.registerTool({ name: 'get_board', inputSchema: {}, execute: editor.getProject });
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const invite = { room: 'a'.repeat(32), password: 'b'.repeat(32) };
  const room = await connectAgentBridge({
    selfId: 'host', onPeerJoin() {}, onPeerLeave() {}, onMessage() {}, leave() {}
  }, invite, url, () => {});
  t.after(() => room.leave());
  let peer;
  room.onPeerJoin(id => { peer = id; });
  room.onMessage('read', (_, id) => room.send('state', { title: 'Example' }, id));
  const join = await fetch(url + '/v1/rooms/' + invite.room + '/agents', {
    method: 'POST', headers: { Authorization: 'Bearer ' + invite.password }
  });
  assert.equal(join.status, 201);
  const guest = await join.json();
  const headers = { Authorization: 'Bearer ' + guest.token };
  const board = await fetch(url + guest.tools + '/get_board', {
    method: 'POST', headers, body: '{}'
  });
  assert.deepEqual(await board.json(), { title: 'Example' });
  await room.send('ask', { sequence: 1, noteId: 'N1' }, peer);

  const curl = promisify(execFile)('curl', ['--no-buffer', '--silent', '--show-error', '--max-time', '5',
    '--fail', '--header', 'Authorization: Bearer ' + guest.token, url + guest.events]);
  let events = '';
  await new Promise((resolve, reject) => {
    curl.child.stdout.on('data', chunk => {
      events += chunk;
      if (events.includes('"noteId":"N1"')) resolve();
    });
    curl.then(() => reject(new Error('Event stream closed early')), reject);
  });
  room.leave();
  const { stdout } = await curl;
  assert.match(stdout, /event: ready/);
  assert.match(stdout, /event: ask_ai/);
  assert.match(stdout, /event: session_ended/);
});
