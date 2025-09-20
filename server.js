const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const cors = require('cors');  // 👈 add this

const app = express();
const server = http.createServer(app);

// ✅ Allow both frontend ports (3000 & 3001) or just one during dev
const allowedOrigins = ["http://localhost:3000", "http://localhost:3001"];

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));
app.use(express.json());

// ✅ Configure Socket.IO CORS
const io = new SocketIOServer(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
    },
});


// Local MongoDB URI from user input
const MONGO_URI = "mongodb://localhost:27017/forex_trading_app";
const JWT_SECRET = 'your_jwt_secret_key'; // Replace with a secure key in production
const API_KEY = "8054406b211345b306fc684e";
const BASE_URL = `https://api.exchangerate-api.com/v4/latest`;

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

// Database Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    wallet: {
        type: Map,
        of: Number,
        default: { USD: 10000, EUR: 0, GBP: 0, JPY: 0, INR: 0 }
    }
});

userSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

const tradeSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    currencyPair: { type: String, required: true },
    action: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    profit: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);
const Trade = mongoose.model('Trade', tradeSchema);

// JWT Authentication Middleware
const auth = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).send({ error: 'Authentication required.' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).send({ error: 'Invalid token.' });
    }
};

// API Endpoints
app.post('/api/signup', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = new User({ username, password });
        await user.save();
        const token = jwt.sign({ _id: user._id, username: user.username }, JWT_SECRET);
        res.status(201).send({ username: user.username, token });
    } catch (err) {
        res.status(400).send({ error: 'Username already exists or invalid data.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).send({ error: 'Invalid login credentials.' });
        }
        const token = jwt.sign({ _id: user._id, username: user.username }, JWT_SECRET);
        res.status(200).send({ username: user.username, token });
    } catch (err) {
        res.status(500).send({ error: 'Server error during login.' });
    }
});

app.get('/api/wallet', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('wallet');
        if (!user) {
            return res.status(404).send({ error: 'User not found.' });
        }
        res.status(200).send(user.wallet);
    } catch (err) {
        res.status(500).send({ error: 'Server error fetching wallet.' });
    }
});

app.post('/api/trades', auth, async (req, res) => {
    try {
        const { currencyPair, action, price, quantity } = req.body;
        const [base, quote] = currencyPair.split('/');
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).send({ error: 'User not found.' });
        }
        if (user.wallet.get(base) === undefined || user.wallet.get(quote) === undefined) {
            return res.status(400).send({ error: 'Invalid currency pair in wallet.' });
        }

        const tradeVolume = price * quantity;
        let profit = 0;

        if (action === 'Buy') {
            if (user.wallet.get(base) < tradeVolume) {
                return res.status(400).send({ error: `Insufficient ${base} funds for this trade.` });
            }
            user.wallet.set(base, user.wallet.get(base) - tradeVolume);
            user.wallet.set(quote, user.wallet.get(quote) + quantity);
        } else if (action === 'Sell') {
            if (user.wallet.get(quote) < quantity) {
                return res.status(400).send({ error: `Insufficient ${quote} funds for this trade.` });
            }
            user.wallet.set(base, user.wallet.get(base) + tradeVolume);
            user.wallet.set(quote, user.wallet.get(quote) - quantity);
            
            // For simplicity, profit is calculated based on the difference between the trade price and a simple 0.05% change
            // A more complex system would track entry price and multiple positions.
            const profitLossValue = tradeVolume * (Math.random() * 0.001 - 0.0005); // A small random profit/loss
            profit = profitLossValue;
            user.wallet.set(base, user.wallet.get(base) + profit); // Add profit/loss to the wallet
        } else {
            return res.status(400).send({ error: 'Invalid trade action.' });
        }

        await user.save();

        const trade = new Trade({
            orderId: uuidv4(),
            userId: user._id,
            currencyPair,
            action,
            price,
            quantity,
            status: 'FILLED',
            profit
        });
        await trade.save();
        
        res.status(201).send(trade);
    } catch (err) {
        console.error("Trade error:", err);
        res.status(500).send({ error: 'Server error placing trade.' });
    }
});

app.get('/api/trades', auth, async (req, res) => {
    try {
        const trades = await Trade.find({ userId: req.user._id }).sort({ timestamp: -1 });
        res.status(200).send(trades);
    } catch (err) {
        res.status(500).send({ error: 'Server error fetching trades.' });
    }
});

// WebSocket for real-time data streaming
let currentRates = null;
let pricesHistory = []; // Store price history for indicator calculations

const calculateSMA = (prices, period) => {
    if (prices.length < period) return prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const slice = prices.slice(-period);
    return slice.reduce((sum, p) => sum + p, 0) / period;
};

const calculateRSI = (prices, period = 14) => {
    if (prices.length < period + 1) return 50;
    const changes = prices.slice(1).map((p, i) => p - prices[i]);
    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

    const avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
    const avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

const getPredictionFromML = async (features) => {
    try {
        const response = await axios.post('http://localhost:8000/predict', features);
        return response.data.recommendation;
    } catch (error) {
        console.error('Error calling Python ML API:', error.message);
        return 'Hold';
    }
};

const fetchAndBroadcastRates = async (baseCurrency = 'USD') => {
    try {
        const response = await axios.get(`${BASE_URL}/${baseCurrency}`);
        
        if (response.data.rates) {
            currentRates = response.data.rates;

            // Update price history for indicators
            const currentPrice = currentRates.INR;
            pricesHistory.push(currentPrice);
            if (pricesHistory.length > 50) pricesHistory.shift();

            // Calculate features for ML prediction
            const mockFeatures = {
                Close: currentPrice,
                SMA10: calculateSMA(pricesHistory, 10),
                SMA50: calculateSMA(pricesHistory, 50),
                EMA20: currentPrice, // Mocking EMA
                RSI14: calculateRSI(pricesHistory, 14),
                ATR14: 1.0, // Mocking ATR
                BBand_Upper: 80.0, // Mocking BB
                BBand_Lower: 70.0, // Mocking BB
                Volatility20: 0.5, // Mocking Volatility
            };
            
            // Get prediction from the Python service
            const mlRecommendation = await getPredictionFromML(mockFeatures);

            io.sockets.emit('latest_rates_update', {
                base: baseCurrency,
                conversion_rates: currentRates,
                ml_recommendation: mlRecommendation,
            });
            console.log(`Broadcasted latest rates and ML recommendation (${mlRecommendation}) to all clients.`);
        } else {
            io.sockets.emit('error', 'Invalid API response format.');
        }

    } catch (error) {
        console.error('API call error:', error.message);
        io.sockets.emit('error', 'Failed to fetch currency rates from API.');
    }
};

fetchAndBroadcastRates();
setInterval(fetchAndBroadcastRates, 60000);

io.on('connection', (socket) => {
    console.log('New client connected to internal WebSocket');
    
    if (currentRates) {
        socket.emit('latest_rates_update', {
            base: 'USD',
            conversion_rates: currentRates,
            ml_recommendation: 'Hold'
        });
    }

    socket.on('request_latest_rates', (baseCurrency) => {
        console.log(`Client requested rates for base currency: ${baseCurrency}`);
        fetchAndBroadcastRates(baseCurrency);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected from internal WebSocket');
    });
});

server.listen(5000, () => {
    console.log('Server is running on http://localhost:5000');
});
