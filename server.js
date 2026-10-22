const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 * 2 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Pass user session ke semua template EJS
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// Penanganan Rute Utama '/' (Mencegah Error "Cannot GET /")
app.get('/', (req, res) => {
    if (req.session && req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// Mount Routes
app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});

module.exports = app;