import express from 'express';
import cors from 'cors';
import config from './config.js';
import { router as upstoxRouter } from './routes/upstox.js';
import { router as userRouter } from './routes/user.js';
import { router as apiRouter } from './routes/api.js';
import { router as scheduleRouter } from './routes/schedule.js';
import { startTrading, stopTrading } from './service/schedule.js';

const app = express();

app.use(cors({ origin: 'http://localhost:5173' }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/upstox", upstoxRouter);
app.use("/user", userRouter);
app.use("/v0", apiRouter);
app.use("/trading", scheduleRouter);


app.use((err, _req, res, _next) => {
  console.error(err); // Log full error server-side
  const message = config.environment === 'production' 
    ? 'Internal server error'
    : err.message;
  res.status(500).json({ error: message });
});

app.get('/', (req, res) => {
      res.send('Hello from our server!')
})

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
