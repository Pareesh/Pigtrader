import express from 'express';
import path from 'path';
import cors from 'cors';
import config from './config.js';
import { router as upstoxRouter } from './routes/upstox.js';
import { router as userRouter } from './routes/user.js';
import { router as apiRouter } from './routes/api.js';
import { router as scheduleRouter } from './routes/schedule.js';
import { router as strategyRouter } from './routes/strategy.js';
import { startTrading, stopTrading } from './service/schedule.js';

const app = express();

app.use(cors({ origin: 'http://localhost:5173' }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/upstox", upstoxRouter);
app.use("/user", userRouter);
app.use("/v0", apiRouter);
app.use("/trading", scheduleRouter);
app.use("/strategy", strategyRouter);

app.use((err, _req, res, _next) => {
  console.error(err); // Log full error server-side
  const message = config.environment === 'production' 
    ? 'Internal server error'
    : err.message;
  res.status(500).json({ error: message });
});

// 2. Serve static files from the React build folder
const buildPath = path.join(import.meta.dirname, '../client/dist');
app.use(express.static(buildPath));

// 3. Catch-all route for client-side routing (React Router)
// Note: In Express v5, use '/{*splat}' instead of '*'
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
});

console.log(buildPath);

const server = app.listen(config.port, config.host, () => {
    console.log(`API http://${config.host}:${config.port}`);
    try {
        // startTrading();
    } catch (e) {
        console.warn("Scheduler not started:", e.message);
    }
});

// 4. Graceful Shutdown
function shutdown() {
    stopTrading();
    server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
