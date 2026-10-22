const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

// GET Login Page
router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('auth/login', { error: null });
});

// POST Login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.render('auth/login', { error: 'Username atau password salah!' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.render('auth/login', { error: 'Username atau password salah!' });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            nama: user.nama,
            role: user.role,
            nama_seksi: user.nama_seksi
        };

        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// GET Register Page
router.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('auth/register', { 
        error: null, 
        formData: {}, 
        isUsernameError: false 
    });
});

// POST Register
router.post('/register', async (req, res) => {
    const { username, nama, nama_seksi, password, confirm_password, role, admin_code } = req.body;
    const formData = { username, nama, nama_seksi, role, admin_code };

    try {
        if (password !== confirm_password) {
            return res.render('auth/register', { 
                error: 'Konfirmasi password tidak cocok!', 
                formData, 
                isUsernameError: false 
            });
        }

        // Validasi Format Username (Min 4 Karakter & Huruf/Angka saja)
        const usernameRegex = /^[a-zA-Z0-9]{4,}$/;
        if (!usernameRegex.test(username)) {
            return res.render('auth/register', { 
                error: 'Username minimal 4 karakter dan hanya boleh terdiri dari huruf dan angka!', 
                formData, 
                isUsernameError: true 
            });
        }

        const existingRes = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (existingRes.rows.length > 0) {
            return res.render('auth/register', { 
                error: 'Username sudah digunakan!', 
                formData, 
                isUsernameError: true 
            });
        }

        let userRole = 'pegawai';
        if (role === 'admin') {
            if (admin_code !== 'ADMINKPP') {
                return res.render('auth/register', { 
                    error: 'Kode Admin tidak valid!', 
                    formData, 
                    isUsernameError: false 
                });
            }
            userRole = 'admin';
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, nama, nama_seksi, password, role) VALUES ($1, $2, $3, $4, $5)',
            [username, nama, nama_seksi, hashedPassword, userRole]
        );

        res.redirect('/login');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mendaftar: ' + err.message);
    }
});

// GET Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// GET Profile Page
router.get('/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        const userRes = await db.query('SELECT id, username, nama, nama_seksi, role FROM users WHERE id = $1', [req.session.user.id]);
        const user = userRes.rows[0];
        res.render('profile', { user, error: null, success: null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// POST Update Profile
router.post('/profile/update', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { nama, username, nama_seksi, password_confirm } = req.body;
    const userId = req.session.user.id;

    try {
        const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
        const currentUser = userRes.rows[0];

        // Validasi Username: Minimal 4 karakter & Alphanumeric
        const usernameRegex = /^[a-zA-Z0-9]{4,}$/;
        if (!usernameRegex.test(username)) {
            return res.render('profile', {
                user: { ...currentUser, nama, username, nama_seksi },
                error: 'Username minimal 4 karakter dan hanya boleh terdiri dari huruf dan angka (tanpa spasi/simbol).',
                success: null
            });
        }

        // Jika Username Diubah, Wajib Konfirmasi Password
        const isUsernameChanged = username.trim() !== currentUser.username;
        if (isUsernameChanged) {
            if (!password_confirm) {
                return res.render('profile', {
                    user: { ...currentUser, nama, username, nama_seksi },
                    error: 'Konfirmasi password diperlukan untuk mengubah username.',
                    success: null
                });
            }

            const validPassword = await bcrypt.compare(password_confirm, currentUser.password);
            if (!validPassword) {
                return res.render('profile', {
                    user: { ...currentUser, nama, username, nama_seksi },
                    error: 'Password konfirmasi salah. Perubahan username dibatalkan.',
                    success: null
                });
            }

            const checkUsername = await db.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, userId]);
            if (checkUsername.rows.length > 0) {
                return res.render('profile', {
                    user: { ...currentUser, nama, username, nama_seksi },
                    error: 'Username sudah digunakan oleh pengguna lain.',
                    success: null
                });
            }
        }

        await db.query(
            'UPDATE users SET nama = $1, username = $2, nama_seksi = $3 WHERE id = $4',
            [nama, username, nama_seksi, userId]
        );

        req.session.user.nama = nama;
        req.session.user.username = username;
        req.session.user.nama_seksi = nama_seksi;

        const updatedUserRes = await db.query('SELECT id, username, nama, nama_seksi, role FROM users WHERE id = $1', [userId]);

        res.render('profile', {
            user: updatedUserRes.rows[0],
            error: null,
            success: 'Profil berhasil diperbarui!'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal memperbarui profil: ' + err.message);
    }
});

module.exports = router;