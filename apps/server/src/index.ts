import { startGameServer } from './net/server';

const port = Number(process.env.PORT ?? 3001);
const clientOrigin = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim())
  : 'http://localhost:5173';

const server = await startGameServer({ port, clientOrigin });
console.log(`Game server listening on port ${server.port}`);