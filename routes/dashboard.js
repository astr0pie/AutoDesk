const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Middleware Cek Auth
const authMiddleware = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

router.use(authMiddleware);

// Main Dashboard
router.get('/', async (req, res) => {
    try {
        const { show_all, bulan, tahun } = req.query;

        // Query data mobil + peminjam aktif hari ini
        const mobilRes = await db.query(`
            SELECT m.id, m.plat_nomor, m.merk_tipe, m.kategori, m.kapasitas, m.tahun, m.status, m.kondapat_catatan,
                   p.id as peminjaman_id,
                   p.tujuan_peminjaman, 
                   p.tgl_mulai, 
                   p.tgl_selesai, 
                   p.lama_pinjam_hari,
                   p.status_peminjaman,
                   u.nama as nama_peminjam, 
                   u.username as username_peminjam,
                   u.nama_seksi as seksi_peminjam
            FROM mobil m
            LEFT JOIN peminjaman p ON m.id = p.mobil_id 
                 AND p.status_peminjaman IN ('APPROVED', 'PENDING')
                 AND CURRENT_DATE BETWEEN DATE(p.tgl_mulai) AND DATE(p.tgl_selesai)
            LEFT JOIN users u ON p.user_id = u.id
            ORDER BY m.id ASC
        `);
        const mobilList = mobilRes.rows;
        
        if (req.session.user.role === 'admin') {
            let whereClause = "WHERE 1=1";
            let queryParams = [];

            // Filtering bawaan: 1 bulan terakhir jika show_all tidak aktif & tidak ada filter bulan spesifik
            if (show_all !== 'true' && !bulan) {
                whereClause += " AND p.tgl_mulai >= NOW() - INTERVAL '1 month'";
            }

            // Filtering spesifik Bulan & Tahun
            if (bulan && tahun) {
                queryParams.push(parseInt(bulan));
                queryParams.push(parseInt(tahun));
                whereClause += ` AND EXTRACT(MONTH FROM p.tgl_mulai) = $${queryParams.length - 1} AND EXTRACT(YEAR FROM p.tgl_mulai) = $${queryParams.length}`;
            }

            const peminjamanRes = await db.query(`
                SELECT p.*, u.nama as nama_user, u.username, u.nama_seksi, m.merk_tipe, m.plat_nomor 
                FROM peminjaman p
                JOIN users u ON p.user_id = u.id
                JOIN mobil m ON p.mobil_id = m.id
                ${whereClause}
                ORDER BY p.id DESC
            `, queryParams);

            const allLogs = peminjamanRes.rows;

            // Pemisahan log berdasarkan kategori
            const pendingList = allLogs.filter(p => p.status_peminjaman === 'PENDING');
            const approvedList = allLogs.filter(p => p.status_peminjaman === 'APPROVED');
            const finishedList = allLogs.filter(p => p.status_peminjaman === 'RETURNED' || p.status_peminjaman === 'REJECTED');

            res.render('dashboard_admin', { 
                mobilList, 
                pendingList,
                approvedList,
                finishedList,
                showAll: show_all === 'true',
                selectedBulan: bulan || '',
                selectedTahun: tahun || new Date().getFullYear()
            });
        } else {
            let userWhereClause = "WHERE p.user_id = $1";
            let userQueryParams = [req.session.user.id];

            if (show_all !== 'true') {
                userWhereClause += " AND p.tgl_mulai >= NOW() - INTERVAL '1 month'";
            }

            const myPinjamRes = await db.query(`
                SELECT p.*, m.merk_tipe, m.plat_nomor 
                FROM peminjaman p
                JOIN mobil m ON p.mobil_id = m.id
                ${userWhereClause}
                ORDER BY p.id DESC
            `, userQueryParams);

            const myPinjam = myPinjamRes.rows;
            res.render('dashboard_pegawai', { mobilList, pinjamList: myPinjam, showAll: show_all === 'true' });
        }
    } catch (err) {
        console.error('DETAIL ERROR DASHBOARD:', err);
        res.status(500).send('Database Error: ' + err.message);
    }
});

// API Endpoint: Get Daftar Jadwal Ter-booking untuk Kalender
router.get('/mobil/:id/jadwal', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            SELECT p.id, p.tgl_mulai, p.tgl_selesai, p.tujuan_peminjaman, p.status_peminjaman,
                   u.nama as nama_peminjam, u.nama_seksi
            FROM peminjaman p
            JOIN users u ON p.user_id = u.id
            WHERE p.mobil_id = $1 AND p.status_peminjaman IN ('APPROVED', 'PENDING')
            ORDER BY p.tgl_mulai ASC
        `, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengambil jadwal' });
    }
});

// Pegawai: Ajukan Peminjaman (Dengan Cek Overlap Tanggal)
router.post('/pinjam', async (req, res) => {
    const { mobil_id, tujuan, tgl_mulai, tgl_selesai } = req.body;
    const userId = req.session.user.id;

    try {
        const overlapCheck = await db.query(`
            SELECT id FROM peminjaman 
            WHERE mobil_id = $1 
              AND status_peminjaman IN ('APPROVED', 'PENDING')
              AND (tgl_mulai <= $3 AND tgl_selesai >= $2)
        `, [mobil_id, tgl_mulai, tgl_selesai]);

        if (overlapCheck.rows.length > 0) {
            return res.status(400).send(`
                <script>
                    alert('Gagal! Tanggal yang Anda pilih sudah ter-booking oleh pegawai lain.');
                    window.location.href = '/dashboard';
                </script>
            `);
        }

        const start = new Date(tgl_mulai);
        const end = new Date(tgl_selesai);
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;

        await db.query(
            'INSERT INTO peminjaman (user_id, mobil_id, tujuan_peminjaman, tgl_mulai, tgl_selesai, lama_pinjam_hari, status_peminjaman) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [userId, mobil_id, tujuan, tgl_mulai, tgl_selesai, diffDays, 'PENDING']
        );
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengajukan peminjaman: ' + err.message);
    }
});

// Pegawai: Pengembalian Mobil
router.post('/kembalikan', async (req, res) => {
    const { peminjaman_id, mobil_id, catatan_kondisi } = req.body;
    try {
        await db.query('UPDATE peminjaman SET status_peminjaman = $1 WHERE id = $2', ['RETURNED', peminjaman_id]);
        await db.query('UPDATE mobil SET status = $1, kondapat_catatan = $2 WHERE id = $3', ['FREE', catatan_kondisi, mobil_id]);
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengembalikan mobil');
    }
});

// Admin: Ubah Status Peminjaman
router.post('/admin/peminjaman/status', async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
    const { peminjaman_id, mobil_id, status_peminjaman } = req.body;
    
    try {
        await db.query('UPDATE peminjaman SET status_peminjaman = $1 WHERE id = $2', [status_peminjaman, peminjaman_id]);
        
        if (status_peminjaman === 'APPROVED') {
            await db.query('UPDATE mobil SET status = $1 WHERE id = $2', ['DIPINJAM', mobil_id]);
        } else if (status_peminjaman === 'RETURNED' || status_peminjaman === 'REJECTED') {
            await db.query('UPDATE mobil SET status = $1 WHERE id = $2', ['FREE', mobil_id]);
        }

        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengubah status peminjaman');
    }
});

// Admin: Tambah Mobil Baru
router.post('/mobil/tambah', async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
    const { plat_nomor, merk_tipe, kategori, kapasitas, tahun, kondapat_catatan } = req.body;
    try {
        await db.query(
            'INSERT INTO mobil (plat_nomor, merk_tipe, kategori, kapasitas, tahun, status, kondapat_catatan) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [plat_nomor, merk_tipe, kategori, parseInt(kapasitas), tahun ? parseInt(tahun) : null, 'FREE', kondapat_catatan]
        );
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal menambah mobil');
    }
});

// Admin: Hapus Mobil
router.post('/mobil/hapus', async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
    const { mobil_id } = req.body;
    try {
        await db.query('DELETE FROM mobil WHERE id = $1', [mobil_id]);
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Gagal menghapus mobil:', err);
        res.status(500).send('Gagal menghapus data mobil. Pastikan mobil tidak sedang dalam status dipinjam.');
    }
});

// Admin: Edit Data Mobil
router.post('/mobil/edit', async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
    const { mobil_id, plat_nomor, merk_tipe, kategori, kapasitas, tahun, status, kondapat_catatan } = req.body;
    const catatan = kondapat_catatan ? kondapat_catatan.trim() : '';

    try {
        await db.query(
            `UPDATE mobil 
             SET plat_nomor = $1, merk_tipe = $2, kategori = $3, kapasitas = $4, tahun = $5, status = $6, kondapat_catatan = $7 
             WHERE id = $8`,
            [plat_nomor, merk_tipe, kategori, parseInt(kapasitas), tahun ? parseInt(tahun) : null, status, catatan, mobil_id]
        );
        res.redirect('/dashboard');
    } catch (err) {
        console.error('DETAIL ERROR EDIT MOBIL:', err);
        res.status(500).send('Gagal memperbarui data mobil: ' + err.message);
    }
});

module.exports = router;