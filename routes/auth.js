const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

// Halaman Root Redirect
router.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

// GET Login
router.get('/login', (req, res) => {
    res.render('auth/login', { error: null });
});

// POST Login (Username & Password)
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const rows = result.rows;

        if (rows.length === 0) {
            return res.render('auth/login', { error: 'Username atau password salah!' });
        }
        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.render('auth/login', { error: 'Username atau password salah!' });
        }
        req.session.user = { 
            id: user.id, 
            username: user.username, 
            nama: user.nama, 
            nama_seksi: user.nama_seksi || '-',
            role: user.role, 
            jabatan: user.jabatan, 
            no_hp: user.no_hp 
        };
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.render('auth/login', { error: 'Terjadi kesalahan sistem' });
    }
});

// GET Register
router.get('/register', (req, res) => {
    res.render('auth/register', { error: null });
});

// POST Register (Menangkap & Mengimpan nama_seksi)
router.post('/register', async (req, res) => {
    const { username, nama, nama_seksi, password, confirm_password, role, admin_code } = req.body;
    try {
        if (password !== confirm_password) {
            return res.render('auth/register', { error: 'Konfirmasi password tidak cocok!' });
        }

        const existingRes = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (existingRes.rows.length > 0) {
            return res.render('auth/register', { error: 'Username sudah digunakan!' });
        }

        let userRole = 'pegawai';

        if (role === 'admin') {
            const secretKey = process.env.ADMIN_SECRET_KEY || 'ADM1998';
            if (!admin_code || admin_code.trim() !== secretKey) {
                return res.render('auth/register', { error: 'Secret Code Admin salah atau belum diisi!' });
            }
            userRole = 'admin';
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, nama, nama_seksi, password, role, jabatan, no_hp) VALUES ($1, $2, $3, $4, $5, $6, $7)', 
            [username, nama, nama_seksi || '-', hashedPassword, userRole, userRole === 'admin' ? 'Admin Operasional' : 'Pegawai Kantor', '-']
        );
        res.redirect('/login');
    } catch (err) {
        console.error(err);
        res.render('auth/register', { error: 'Gagal melakukan registrasi: ' + err.message });
    }
});

// GET Logout
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// GET Profile
router.get('/profile', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('profile');
});

module.exports = router;