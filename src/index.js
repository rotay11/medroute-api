require('dotenv').config();
const express     = require('express');
const http        = require('http');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const { Server }  = require('socket.io');
const logger      = require('./utils/logger');
const { initSocket } = require('./services/socketService');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', methods:['GET','POST'], credentials:true },
});
initSocket(io);
app.set('io', io);

app.use(helmet());
app.use(cors({ origin: (origin, cb) => { const allowed = process.env.ALLOWED_ORIGINS?.split(',') || []; if (!origin || allowed.includes(origin)) return cb(null,true); cb(new Error('Not allowed by CORS')); }, credentials:true }));
app.set("trust proxy", 1);
app.set("trust proxy", 1);
app.use(compression());
app.use(express.json({ limit:'10mb' }));
app.use(express.urlencoded({ extended:true }));
app.use(morgan('dev'));

const loginLimiter   = rateLimit({ windowMs:15*60*1000, max:10, message:{ error:'Too many login attempts. Try again in 15 minutes.' } });
const generalLimiter = rateLimit({ windowMs:60*1000, max:300 });
app.use('/api', generalLimiter);
app.use('/api/auth/login', loginLimiter);

app.use('/api/health',   require('./routes/health'));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/driver',   require('./routes/driver'));
app.use('/api/scan',     require('./routes/scan'));
app.use('/api/bundle',   require('./routes/bundle'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/gps',      require('./routes/gps'));
app.use('/api/dispatch', require('./routes/dispatch'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/portal',   require('./routes/portal'));
app.use('/api/manifest', require('./routes/manifest'));
app.use('/api/register', require('./routes/register'));
app.use('/api/superadmin', require('./routes/superadmin'));

app.use((req, res) => res.status(404).json({ error:'Route not found' }));
app.use((err, req, res, next) => {
  logger.error(err.message, { stack:err.stack });
  res.status(err.status||500).json({ error: process.env.NODE_ENV==='production' && !err.status ? 'Internal server error' : err.message });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`MedRoute API running on http://localhost:${PORT}`));
module.exports = { app, server };
