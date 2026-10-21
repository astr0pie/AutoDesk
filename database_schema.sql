CREATE DATABASE IF NOT EXISTS db_peminjaman_mobil;
USE db_peminjaman_mobil;

-- Reset tabel lama jika ada
DROP TABLE IF EXISTS peminjaman;
DROP TABLE IF EXISTS mobil;
DROP TABLE IF EXISTS users;

-- 1. Tabel Users
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    nama VARCHAR(100) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('admin', 'pegawai') DEFAULT 'pegawai',
    jabatan VARCHAR(50) DEFAULT 'Pegawai Kantor',
    no_hp VARCHAR(20) DEFAULT '-',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabel Mobil Dinas
CREATE TABLE mobil (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plat_nomor VARCHAR(20) NOT NULL UNIQUE,
    merk_tipe VARCHAR(100) NOT NULL,
    kategori VARCHAR(50),
    kapasitas INT,
    tahun INT,
    status ENUM('FREE', 'DIPINJAM', 'MAINTENANCE') DEFAULT 'FREE',
    kondapat_catatan TEXT NULL
);

-- 3. Tabel Peminjaman Mobil
CREATE TABLE peminjaman (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    mobil_id INT NOT NULL,
    tujuan_peminjaman TEXT NOT NULL,
    tgl_mulai DATETIME NOT NULL,
    tgl_selesai DATETIME NOT NULL,
    lama_pinjam_hari INT NOT NULL,
    status_peminjaman ENUM('PENDING', 'APPROVED', 'REJECTED', 'RETURNED') DEFAULT 'PENDING',
    catatan_kembali TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (mobil_id) REFERENCES mobil(id) ON DELETE CASCADE
);

-- Seed Data Admin Bawaan (Username: admin | Password: password123)
INSERT INTO users (username, nama, password, role, jabatan) VALUES
('admin', 'Administrator Utama', '$2y$10$e0MYzXyjpJS7Pd0RVvHwHe1NIsZ52XbJ.R6s64aTzZ0G9w9N7/N6G', 'admin', 'Pengelola Aset');

-- Seed Data Mobil
INSERT INTO mobil (plat_nomor, merk_tipe, kategori, kapasitas, tahun, status, kondapat_catatan) VALUES
('B 1024 RFS', 'Toyota Innova Zenix', 'MPV', 7, 2023, 'FREE', 'AC dingin, siap pakai'),
('B 1888 DKM', 'Honda CR-V', 'SUV', 5, 2022, 'FREE', 'Ban depan kanan perlu tambah angin'),
('B 2045 TUA', 'Toyota Avanza Veloz', 'MPV', 7, 2021, 'FREE', 'Baret halus di bumper belakang'),
('B 7701 PPA', 'Mitsubishi Pajero Sport', 'SUV', 7, 2023, 'FREE', 'Kondisi mulus & prima');