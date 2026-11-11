import { Server, utils, type Connection } from 'ssh2';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Transform } from 'node:stream';
import { hostFingerprint } from '../../packages/tools/src/deployment/transport';
export async function sftpFixture() {
  const binary = [
    '/usr/libexec/sftp-server',
    '/usr/lib/openssh/sftp-server',
    '/usr/lib/ssh/sftp-server',
  ].find(existsSync);
  if (!binary)
    throw new Error('Install OpenSSH sftp-server to run the real SFTP integration tests.');
  const keys = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(keys.private);
  if (parsed instanceof Error) throw parsed;
  const clients = new Set<Connection>();
  const processes = new Set<ChildProcess>();
  let authenticated = 0;
  let dropRename = false;
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (
        (context.method === 'password' && context.password === 'fixture-password') ||
        context.method === 'publickey'
      ) {
        authenticated++;
        context.accept();
      } else context.reject(['password', 'publickey']);
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        accept().on('subsystem', (accept, reject, info) => {
          if (info.name !== 'sftp') {
            reject();
            return;
          }
          const stream = accept();
          const process = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
          processes.add(process);
          process.on('exit', () => {
            processes.delete(process);
            stream.end();
          });
          stream.on('error', () => {});
          process.stdin.on('error', () => {});
          let renameId: number | undefined;
          const frames = (inspect: (packet: Buffer) => boolean) => {
            let pending = Buffer.alloc(0);
            return new Transform({
              transform(chunk, _encoding, done) {
                pending = Buffer.concat([pending, chunk]);
                while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
                  const length = pending.readUInt32BE(0) + 4;
                  const packet = pending.subarray(0, length);
                  pending = pending.subarray(length);
                  if (inspect(packet)) this.push(packet);
                }
                done();
              },
            });
          };
          stream
            .pipe(
              frames((packet) => {
                if (
                  dropRename &&
                  packet[4] === 200 &&
                  packet.includes(Buffer.from('posix-rename@openssh.com'))
                )
                  renameId = packet.readUInt32BE(5);
                return true;
              }),
            )
            .pipe(process.stdin);
          process.stdout
            .pipe(
              frames((packet) => {
                if (
                  renameId !== undefined &&
                  packet[4] === 101 &&
                  packet.readUInt32BE(5) === renameId &&
                  packet.readUInt32BE(9) === 0
                ) {
                  dropRename = false;
                  client.end();
                  return false;
                }
                return true;
              }),
            )
            .pipe(stream);
          stream.on('close', () => process.kill());
        });
      }),
    );
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    key: keys.private,
    fingerprint: hostFingerprint(parsed.getPublicSSH()),
    authenticated: () => authenticated,
    dropNextRenameReply: () => {
      dropRename = true;
    },
    close: async () => {
      for (const client of clients) client.end();
      for (const process of processes) process.kill();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
