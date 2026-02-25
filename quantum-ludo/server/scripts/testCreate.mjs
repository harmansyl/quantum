import http from 'http';

const payload = JSON.stringify({ name: 'TEST CREATE', total_players: 64, creator: 'cli-test' });

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/tournaments/create',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
  timeout: 5000,
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log('BODY', data);
  });
});
req.on('error', (e) => console.error('REQUEST ERROR', e.message));
req.write(payload);
req.end();
