const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

// Provided MongoDB URI
const MONGO_URI = 'mongodb://localhost:27017/forex_trading_app';
const JWT_SECRET = 'your-super-strong-jwt-secret'; // IMPORTANT: Change this in a real application
const EXCHANGERATE_API_KEY = '8054406b211345b306fc684e';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected successfully!');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1); // Exit process with failure
  }
};

// Define Mongoose Schemas and Models
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model('User', userSchema);

const tradeSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  currencyPair: { type: String, required: true },
  action: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  status: { type: String, required: true },
  timestamp: { type: Number, required: true },
  profit: { type: Number, default: 0 }
});
const Trade = mongoose.model('Trade', tradeSchema);

// Middleware for token authentication
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- REST API Endpoints ---

// User Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();
    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    res.status(400).json({ error: 'Username already exists or invalid input' });
  }
});

// User Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, username: user.username });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// API endpoint to place a new trade (protected)
app.post('/api/trades', authenticateToken, async (req, res) => {
  try {
    const tradeData = req.body;
    
    // Simulate a successful trade
    const newTrade = new Trade({
      ...tradeData,
      orderId: crypto.randomUUID(),
      status: 'Filled',
      timestamp: Date.now(),
      profit: Math.random() * 10 - 5 // Simulate a profit/loss between -$5 and +$5
    });

    await newTrade.save();

    console.log("Trade placed successfully:", newTrade.orderId);
    res.status(201).json(newTrade);
  } catch (error) {
    console.error("Error placing trade:", error);
    res.status(500).json({ error: 'Failed to place trade' });
  }
});

// API endpoint to get all trades (protected)
app.get('/api/trades', authenticateToken, async (req, res) => {
    try {
        const trades = await Trade.find({}).sort({ timestamp: -1 });
        res.status(200).json(trades);
    } catch (error) {
        console.error("Error fetching trades:", error);
        res.status(500).json({ error: 'Failed to fetch trades' });
    }
});

// API endpoint to get user's analytics (protected)
app.get('/api/analytics', authenticateToken, async (req, res) => {
  try {
    const trades = await Trade.find({});
    
    const totalVolume = trades.reduce((sum, trade) => sum + trade.quantity, 0);
    const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
    const totalTradesCount = trades.length;

    res.status(200).json({
      totalVolume,
      totalProfit,
      totalTradesCount
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// --- WebSocket Handlers ---
io.on('connection', (socket) => {
  console.log('A user connected via WebSocket');

  // Request latest rates for a base currency
  socket.on('request_latest_rates', async (baseCurrency) => {
    try {
      const response = await axios.get(`https://v6.exchangerate-api.com/v6/${EXCHANGERATE_API_KEY}/latest/${baseCurrency}`);
      socket.emit('latest_rates_update', response.data);
    } catch (error) {
      console.error('Error fetching latest rates:', error);
      socket.emit('error', 'Failed to fetch latest rates.');
    }
  });

  // Request historical rates for a base currency (simulated for demo)
  socket.on('request_historical_data', (data) => {
    console.log(`Received request for historical data: ${JSON.stringify(data)}`);
    const { baseCurrency, dateRange } = data;
    const historicalRates = [];
    const endDate = new Date();
    for (let i = 0; i < 30; i++) {
        const date = new Date();
        date.setDate(endDate.getDate() - i);
        historicalRates.push({
            date: date.toISOString().split('T')[0],
            rate: 1.2 + (Math.random() - 0.5) * 0.1, // Simulated rates
        });
    }
    socket.emit('historical_data_update', historicalRates);
  });

  // Request list of all currencies
  socket.on('request_currencies', async () => {
    try {
      const response = await axios.get(`https://v6.exchangerate-api.com/v6/${EXCHANGERATE_API_KEY}/latest/USD`);
      const currencies = Object.keys(response.data.conversion_rates);
      socket.emit('currencies_list', currencies);
    } catch (error) {
      console.error('Error fetching currencies:', error);
      socket.emit('error', 'Failed to fetch currency list.');
    }
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});

// Start the server after connecting to the database
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Express server listening at http://localhost:${PORT}`);
  });
});
