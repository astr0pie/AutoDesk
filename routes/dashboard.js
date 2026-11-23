const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Middleware Cek Auth
const authMiddleware = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

router.use(authMiddleware);

// =====================================================================
// Helper tanggal (semua dihitung dengan zona waktu WIB / Asia/Jakarta
// supaya konsisten walau server Vercel berjalan di UTC)
// =====================================================================
const MATRIX_DAYS = 14;
const DOW_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MON_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const pad2 = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const parseIso = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
};
const isValidIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toIso(parseIso(s)) === s;
const addDays = (iso, n) => {
    const d = parseIso(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return toIso(d);
};
const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000);
const todayJakarta = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
const shortDate = (iso, withYear) => {
    const d = parseIso(iso);
    return `${d.getUTCDate()} ${MON_ID[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}`;
};

// Kirim alert + kembali ke dashboard (pesan di-escape agar aman)
const alertBack = (res, status, message) => {
    const safe = JSON.stringify(message).replace(/</g, '\\u003c');
    return res.status(status).send(`<script>alert(${safe}); window.location.href = '/dashboard';</script>`);
};

// Susun data tabel jadwal (mobil x MATRIX_DAYS hari) — hanya menampilkan status APPROVED
function buildMatrix({ mobilList, bookings, startIso, todayIso, maxStartIso, userId, role }) {
    const days = [];
    for (let i = 0; i < MATRIX_DAYS; i++) {
        const iso = addDays(startIso, i);
        const dow = parseIso(iso).getUTCDay();
        days.push({
            iso,
            dow: DOW_ID[dow],
            label: shortDate(iso, false),
            isToday: iso === todayIso,
            isWeekend: dow === 0 || dow === 6
        });
    }

    const isAdmin = role === 'admin';

    const rows = mobilList.map((m) => {
        const cells = [];
        if (m.status === 'MAINTENANCE') {
            cells.push({ type: 'maint', span: MATRIX_DAYS });
            return { mobil: m, cells };
        }

        const mine = bookings.filter((b) => String(b.mobil_id) === String(m.id));
        let i = 0;
        while (i < MATRIX_DAYS) {
            const iso = days[i].iso;
            const b = mine.find((x) => iso >= x.d_mulai && iso <= x.d_selesai);
            if (b) {
                let span = 1;
                while (i + span < MATRIX_DAYS && days[i + span].iso <= b.d_selesai) span++;
                cells.push({
                    type: 'booked',
                    span,
                    own: String(b.user_id) === String(userId),
                    nama: b.nama_user,
                    seksi: b.nama_seksi,
                    tujuan: b.tujuan_peminjaman,
                    mulai: shortDate(b.d_mulai, true),
                    selesai: shortDate(b.d_selesai, true),
                    clipL: b.d_mulai < iso,
                    clipR: b.d_selesai > days[i + span - 1].iso
                });
                i += span;
            } else {
                let type = 'free';
                if (iso < todayIso) type = 'past';
                else if (!isAdmin && iso > maxStartIso) type = 'far';
                cells.push({ type, span: 1, iso });
                i += 1;
            }
        }
        return { mobil: m, cells };
    });

    const endIso = days[MATRIX_DAYS - 1].iso;
    const sameYear = startIso.slice(0, 4) === endIso.slice(0, 4);
    const rangeLabel = `${shortDate(startIso, !sameYear)} - ${shortDate(endIso, true)}`;

    return {
        days,
        rows,
        dayCount: MATRIX_DAYS,
        startIso,
        prevIso: addDays(startIso, -MATRIX_DAYS),
        nextIso: addDays(startIso, MATRIX_DAYS),
        todayIso,
        maxStartIso,
        maxStartLabel: shortDate(maxStartIso, true),
        rangeLabel,
        isCurrentWeek: startIso === todayIso
    };
}

// Main Dashboard
router.get('/', async (req, res) => {
    try {
        const { show_all, bulan, tahun, mobil_id } = req.query;

        // Query data mobil + deteksi apakah sedang dipinjam/booked hari ini (hanya APPROVED)
        const mobilRes = await db.query(`
            SELECT m.id, m.plat_nomor, m.merk_tipe, m.kategori, m.kapasitas, m.tahun, m.status, m.kondapat_catatan,
                   EXISTS (
                       SELECT 1 FROM peminjaman p 
                       WHERE p.mobil_id = m.id 
                       AND p.status_peminjaman = 'APPROVED'
                       AND CURRENT_DATE BETWEEN DATE(p.tgl_mulai) AND DATE(p.tgl_selesai)
                   ) as is_booked
            FROM mobil m
            ORDER BY m.id ASC
        `);
        const mobilList = mobilRes.rows;

        // ===== Data tabel jadwal (mobil x MATRIX_DAYS hari) — hanya APPROVED =====
        const todayIso = todayJakarta();
        const maxStartIso = addDays(todayIso, 7);
        const startIso = isValidIso(req.query.start) ? req.query.start : todayIso;
        const endIso = addDays(startIso, MATRIX_DAYS - 1);

        const weekRes = await db.query(`
            SELECT p.id, p.user_id, p.mobil_id, p.tujuan_peminjaman,
                   TO_CHAR(p.tgl_mulai, 'YYYY-MM-DD') as d_mulai,
                   TO_CHAR(p.tgl_selesai, 'YYYY-MM-DD') as d_selesai,
                   u.nama as nama_user, u.nama_seksi
            FROM peminjaman p
            JOIN users u ON p.user_id = u.id
            WHERE p.status_peminjaman = 'APPROVED'
              AND DATE(p.tgl_mulai) <= $2::date
              AND DATE(p.tgl_selesai) >= $1::date
            ORDER BY p.tgl_mulai ASC
        `, [startIso, endIso]);

        const matrix = buildMatrix({
            mobilList,
            bookings: weekRes.rows,
            startIso,
            todayIso,
            maxStartIso,
            userId: req.session.user.id,
            role: req.session.user.role
        });

        if (req.session.user.role === 'admin') {
            let whereClause = "WHERE 1=1";
            let queryParams = [];

            if (show_all !== 'true' && !bulan && !mobil_id) {
                whereClause += " AND (p.status_peminjaman = 'PENDING' OR p.tgl_mulai >= NOW() - INTERVAL '1 month')";
            }

            if (bulan && tahun) {
                queryParams.push(parseInt(bulan));
                queryParams.push(parseInt(tahun));
                whereClause += ` AND EXTRACT(MONTH FROM p.tgl_mulai) = $${queryParams.length - 1} AND EXTRACT(YEAR FROM p.tgl_mulai) = $${queryParams.length}`;
            }

            if (mobil_id) {
                queryParams.push(parseInt(mobil_id));
                whereClause += ` AND p.mobil_id = $${queryParams.length}`;
            }

            const peminjamanRes = await db.query(`
                SELECT p.id, p.user_id, p.mobil_id, p.tujuan_peminjaman, p.lama_pinjam_hari, p.status_peminjaman,
                       TO_CHAR(p.tgl_mulai, 'DD/MM/YYYY') as tgl_mulai_fmt,
                       TO_CHAR(p.tgl_selesai, 'DD/MM/YYYY') as tgl_selesai_fmt,
                       u.nama as nama_user, u.username, u.nama_seksi, m.merk_tipe, m.plat_nomor 
                FROM peminjaman p
                JOIN users u ON p.user_id = u.id
                JOIN mobil m ON p.mobil_id = m.id
                ${whereClause}
                ORDER BY p.tgl_mulai ASC, p.id ASC
            `, queryParams);

            const allLogs = peminjamanRes.rows;

            const pendingList = allLogs.filter(p => p.status_peminjaman === 'PENDING');
            const approvedList = allLogs.filter(p => p.status_peminjaman === 'APPROVED');
            const finishedList = allLogs.filter(p => p.status_peminjaman === 'RETURNED' || p.status_peminjaman === 'REJECTED');

            res.render('dashboard_admin', { 
                mobilList, 
                matrix,
                pendingList,
                approvedList,
                finishedList,
                showAll: show_all === 'true',
                selectedBulan: bulan || '',
                selectedTahun: tahun || new Date().getFullYear(),
                selectedMobilId: mobil_id || ''
            });
        } else {
            let userWhereClause = "WHERE p.user_id = $1";
            let userQueryParams = [req.session.user.id];

            if (show_all !== 'true') {
                userWhereClause += " AND (p.status_peminjaman = 'PENDING' OR p.tgl_mulai >= NOW() - INTERVAL '1 month')";
            }

            const myPinjamRes = await db.query(`
                SELECT p.id, p.user_id, p.mobil_id, p.tujuan_peminjaman, p.lama_pinjam_hari, p.status_peminjaman,
                       TO_CHAR(p.tgl_mulai, 'DD/MM/YYYY') as tgl_mulai_fmt,
                       TO_CHAR(p.tgl_selesai, 'DD/MM/YYYY') as tgl_selesai_fmt,
                       m.merk_tipe, m.plat_nomor 
                FROM peminjaman p
                JOIN mobil m ON p.mobil_id = m.id
                ${userWhereClause}
                ORDER BY p.tgl_mulai ASC, p.id DESC
            `, userQueryParams);

            const myPinjam = myPinjamRes.rows;
            res.render('dashboard_pegawai', { mobilList, matrix, pinjamList: myPinjam, showAll: show_all === 'true' });
        }
    } catch (err) {
        console.error('DETAIL ERROR DASHBOARD:', err);
        res.status(500).send('Database Error: ' + err.message);
    }
});

// API Endpoint: Get Daftar Jadwal Ter-booking (hanya APPROVED yang mengunci kalender)
router.get('/mobil/:id/jadwal', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            SELECT p.id, 
                   TO_CHAR(p.tgl_mulai, 'YYYY-MM-DD"T"HH24:MI:SS') as tgl_mulai, 
                   TO_CHAR(p.tgl_selesai, 'YYYY-MM-DD"T"HH24:MI:SS') as tgl_selesai,
                   TO_CHAR(p.tgl_mulai, 'DD/MM/YYYY') as tgl_mulai_str,
                   TO_CHAR(p.tgl_selesai, 'DD/MM/YYYY') as tgl_selesai_str,
                   p.tujuan_peminjaman, p.status_peminjaman,
                   u.nama as nama_peminjam, u.nama_seksi
            FROM peminjaman p
            JOIN users u ON p.user_id = u.id
            WHERE p.mobil_id = $1 AND p.status_peminjaman = 'APPROVED'
            ORDER BY p.tgl_mulai ASC
        `, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengambil jadwal' });
    }
});

// API Endpoint: Jadwal peminjaman aktif/diajukan milik seksi user yang sedang login
router.get('/seksi/jadwal', async (req, res) => {
    try {
        const userRes = await db.query('SELECT nama_seksi FROM users WHERE id = $1', [req.session.user.id]);
        const namaSeksi = userRes.rows[0] && userRes.rows[0].nama_seksi ? userRes.rows[0].nama_seksi.trim() : '';
        if (!namaSeksi || namaSeksi === '-') return res.json([]);

        const result = await db.query(`
            SELECT p.id,
                   TO_CHAR(p.tgl_mulai, 'YYYY-MM-DD') as d_mulai,
                   TO_CHAR(p.tgl_selesai, 'YYYY-MM-DD') as d_selesai
            FROM peminjaman p
            JOIN users u ON p.user_id = u.id
            WHERE LOWER(TRIM(u.nama_seksi)) = LOWER($1)
              AND p.status_peminjaman IN ('APPROVED', 'PENDING')
              AND DATE(p.tgl_selesai) >= CURRENT_DATE
            ORDER BY p.tgl_mulai ASC
        `, [namaSeksi]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal mengambil jadwal seksi' });
    }
});

// Pegawai: Ajukan Peminjaman (status awal = 'PENDING' / Diajukan, menunggu persetujuan Admin)
router.post('/pinjam', async (req, res) => {
    const { mobil_id, tujuan, tgl_mulai, tgl_selesai } = req.body;
    const userId = req.session.user.id;

    try {
        const startDate = String(tgl_mulai || '').slice(0, 10);
        const endDate = String(tgl_selesai || '').slice(0, 10);

        if (!isValidIso(startDate) || !isValidIso(endDate)) {
            return alertBack(res, 400, 'Gagal! Tanggal mulai dan tanggal selesai wajib dipilih dari kalender.');
        }
        if (!tujuan || !String(tujuan).trim()) {
            return alertBack(res, 400, 'Gagal! Tujuan dinas / kegiatan wajib diisi.');
        }

        const tglMulaiDb = `${startDate} 00:00:00`;
        const tglSelesaiDb = `${endDate} 23:59:59`;

        // 1. Cek Status Mobil (Kunci jika sedang MAINTENANCE)
        const mobilCheck = await db.query('SELECT status, merk_tipe, plat_nomor FROM mobil WHERE id = $1', [mobil_id]);
        if (mobilCheck.rows.length === 0) {
            return alertBack(res, 404, 'Gagal! Unit mobil tidak ditemukan.');
        }
        if (mobilCheck.rows[0].status === 'MAINTENANCE') {
            return alertBack(res, 400, `Gagal! Mobil ${mobilCheck.rows[0].merk_tipe} (${mobilCheck.rows[0].plat_nomor}) sedang dalam status MAINTENANCE dan tidak dapat dipinjam sampai admin mengubah statusnya menjadi FREE.`);
        }

        // 2. Validasi tanggal
        const todayIso = todayJakarta();
        const maxStartIso = addDays(todayIso, 7);

        if (startDate < todayIso) {
            return alertBack(res, 400, 'Gagal! Tanggal mulai peminjaman tidak boleh sebelum hari ini.');
        }
        if (startDate > maxStartIso) {
            return alertBack(res, 400, 'Gagal! Tanggal mulai peminjaman maksimal H+7 dari hari ini.');
        }
        if (endDate < startDate) {
            return alertBack(res, 400, 'Gagal! Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');
        }

        // 3. Cek Bentrok Jadwal Unit Mobil yang Sama (yang sudah APPROVED)
        const overlapCheck = await db.query(`
            SELECT id FROM peminjaman 
            WHERE mobil_id = $1 
              AND status_peminjaman = 'APPROVED'
              AND (tgl_mulai <= $3 AND tgl_selesai >= $2)
        `, [mobil_id, tglMulaiDb, tglSelesaiDb]);

        if (overlapCheck.rows.length > 0) {
            return alertBack(res, 400, 'Gagal! Tanggal yang Anda pilih pada mobil ini sudah disetujui untuk pegawai lain.');
        }

        // 4. Cek Duplikasi Pengajuan PENDING dari user sendiri pada mobil & tanggal yang sama
        const selfPendingCheck = await db.query(`
            SELECT id FROM peminjaman
            WHERE user_id = $1
              AND mobil_id = $2
              AND status_peminjaman = 'PENDING'
              AND (tgl_mulai <= $4 AND tgl_selesai >= $3)
        `, [userId, mobil_id, tglMulaiDb, tglSelesaiDb]);

        if (selfPendingCheck.rows.length > 0) {
            return alertBack(res, 400, 'Gagal! Anda sudah memiliki pengajuan yang sedang menunggu persetujuan admin pada mobil dan tanggal tersebut.');
        }

        // 5. KUNCI SEKSI: satu seksi tidak boleh meminjam/mengajukan dengan rentang tanggal yang PERSIS SAMA
        const userRes = await db.query('SELECT nama_seksi FROM users WHERE id = $1', [userId]);
        const namaSeksi = userRes.rows[0] && userRes.rows[0].nama_seksi ? userRes.rows[0].nama_seksi.trim() : '';

        if (namaSeksi && namaSeksi !== '-') {
            const seksiSamaCheck = await db.query(`
                SELECT p.id, u.nama as nama_peminjam, m.merk_tipe, m.plat_nomor
                FROM peminjaman p
                JOIN users u ON p.user_id = u.id
                JOIN mobil m ON p.mobil_id = m.id
                WHERE LOWER(TRIM(u.nama_seksi)) = LOWER($1)
                  AND p.status_peminjaman IN ('APPROVED', 'PENDING')
                  AND DATE(p.tgl_mulai) = $2::date
                  AND DATE(p.tgl_selesai) = $3::date
            `, [namaSeksi, startDate, endDate]);

            if (seksiSamaCheck.rows.length > 0) {
                const existing = seksiSamaCheck.rows[0];
                return alertBack(res, 400, `Gagal! Seksi ${namaSeksi} sudah memiliki jadwal/pengajuan peminjaman dengan tanggal yang sama persis (${existing.merk_tipe} - ${existing.plat_nomor} atas nama ${existing.nama_peminjam}). Seksi yang sama tidak boleh meminjam pada rentang tanggal yang persis sama. Silakan pilih tanggal yang berbeda.`);
            }
        }

        const diffDays = daysBetween(startDate, endDate) + 1;

        // Simpan dengan status 'PENDING' (Diajukan) agar menunggu persetujuan Admin
        await db.query(
            'INSERT INTO peminjaman (user_id, mobil_id, tujuan_peminjaman, tgl_mulai, tgl_selesai, lama_pinjam_hari, status_peminjaman) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [userId, mobil_id, String(tujuan).trim(), tglMulaiDb, tglSelesaiDb, diffDays, 'PENDING']
        );
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengajukan peminjaman: ' + err.message);
    }
});

// Pegawai: Batalkan pengajuan sendiri yang masih PENDING
router.post('/batalkan-pengajuan', async (req, res) => {
    const { peminjaman_id } = req.body;
    const userId = req.session.user.id;
    try {
        await db.query(
            `UPDATE peminjaman SET status_peminjaman = 'REJECTED' WHERE id = $1 AND user_id = $2 AND status_peminjaman = 'PENDING'`,
            [peminjaman_id, userId]
        );
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal membatalkan pengajuan');
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

// Admin: Setujui (APPROVED) atau Tolak/Batalkan (REJECTED) Peminjaman
router.post('/admin/peminjaman/status', async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
    const { peminjaman_id, mobil_id, status_peminjaman } = req.body;
    
    try {
        if (status_peminjaman === 'APPROVED') {
            // Ambil detail pengajuan yang akan disetujui
            const targetRes = await db.query(
                'SELECT mobil_id, tgl_mulai, tgl_selesai FROM peminjaman WHERE id = $1',
                [peminjaman_id]
            );
            if (targetRes.rows.length === 0) {
                return alertBack(res, 404, 'Data pengajuan peminjaman tidak ditemukan.');
            }
            const target = targetRes.rows[0];

            // Pastikan unit mobil tidak sedang MAINTENANCE
            const mobilRes = await db.query('SELECT status, merk_tipe, plat_nomor FROM mobil WHERE id = $1', [target.mobil_id]);
            if (mobilRes.rows.length > 0 && mobilRes.rows[0].status === 'MAINTENANCE') {
                return alertBack(res, 400, `Gagal menyetujui! Mobil ${mobilRes.rows[0].merk_tipe} (${mobilRes.rows[0].plat_nomor}) sedang dalam status MAINTENANCE.`);
            }

            // Pastikan tidak bentrok dengan jadwal lain yang sudah APPROVED pada mobil yang sama
            const conflictRes = await db.query(`
                SELECT p.id, u.nama as nama_peminjam
                FROM peminjaman p
                JOIN users u ON p.user_id = u.id
                WHERE p.mobil_id = $1
                  AND p.id <> $2
                  AND p.status_peminjaman = 'APPROVED'
                  AND (p.tgl_mulai <= $4 AND p.tgl_selesai >= $3)
            `, [target.mobil_id, peminjaman_id, target.tgl_mulai, target.tgl_selesai]);

            if (conflictRes.rows.length > 0) {
                return alertBack(res, 400, `Gagal menyetujui! Tanggal peminjaman bentrok dengan jadwal yang sudah disetujui atas nama ${conflictRes.rows[0].nama_peminjam}.`);
            }

            await db.query('UPDATE peminjaman SET status_peminjaman = $1 WHERE id = $2', ['APPROVED', peminjaman_id]);

            // Ubah status mobil menjadi DIPINJAM hanya jika tanggal peminjaman mencakup hari ini
            const todayIso = todayJakarta();
            const isActiveToday = await db.query(`
                SELECT 1 FROM peminjaman
                WHERE id = $1 AND $2::date BETWEEN DATE(tgl_mulai) AND DATE(tgl_selesai)
            `, [peminjaman_id, todayIso]);

            if (isActiveToday.rows.length > 0) {
                await db.query(`UPDATE mobil SET status = 'DIPINJAM' WHERE id = $1 AND status <> 'MAINTENANCE'`, [target.mobil_id]);
            }
        } else if (status_peminjaman === 'RETURNED' || status_peminjaman === 'REJECTED') {
            await db.query('UPDATE peminjaman SET status_peminjaman = $1 WHERE id = $2', [status_peminjaman, peminjaman_id]);
            await db.query(`UPDATE mobil SET status = 'FREE' WHERE id = $1 AND status <> 'MAINTENANCE'`, [mobil_id]);
        }

        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal mengubah status peminjaman: ' + err.message);
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