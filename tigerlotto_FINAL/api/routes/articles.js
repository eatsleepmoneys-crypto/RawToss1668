'use strict';
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { authAdmin } = require('../middleware/auth');

// ── slug helper ────────────────────────────────────────────────────────────
function toSlug(str) {
  return str.toLowerCase()
    .replace(/[^฀-๿a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim().slice(0, 180);
}

// ─── PUBLIC ───────────────────────────────────────────────────────────────

// GET /api/articles — list published articles
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const offset = (page - 1) * limit;

    const rows = await query(
      `SELECT id, uuid, slug, title, excerpt, meta_description, keywords,
              cover_image, og_image, view_count, published_at, created_at
       FROM articles
       WHERE status='published' AND published_at <= NOW()
       ORDER BY published_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM articles WHERE status='published' AND published_at <= NOW()`
    );
    res.json({ success: true, data: rows, total, page, limit });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/articles/:slug — single article + increment view
router.get('/:slug', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM articles WHERE slug=? AND status='published' AND published_at <= NOW() LIMIT 1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบบทความ' });

    // increment view count (fire-and-forget)
    query('UPDATE articles SET view_count=view_count+1 WHERE id=?', [rows[0].id]).catch(() => {});

    // related articles
    const related = await query(
      `SELECT slug, title, excerpt, cover_image, published_at
       FROM articles WHERE status='published' AND id != ? AND published_at <= NOW()
       ORDER BY published_at DESC LIMIT 4`,
      [rows[0].id]
    );
    res.json({ success: true, data: rows[0], related });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN ────────────────────────────────────────────────────────────────

// GET /api/admin/articles
router.get('/admin/list', authAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const status = req.query.status || null;

    const where = status ? 'WHERE status=?' : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    const rows = await query(
      `SELECT id, uuid, slug, title, status, view_count, published_at, created_at, updated_at
       FROM articles ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM articles ${where}`,
      status ? [status] : []
    );
    res.json({ success: true, data: rows, total, page, limit });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/admin/articles — create
router.post('/admin', authAdmin, async (req, res) => {
  try {
    const {
      title, content, excerpt = '',
      meta_title = '', meta_description = '', keywords = '',
      og_image = '', cover_image = '',
      status = 'draft', published_at = null,
    } = req.body;

    if (!title) return res.status(400).json({ success: false, message: 'title จำเป็น' });

    let slug = toSlug(title);
    // ensure unique slug
    const existing = await query('SELECT id FROM articles WHERE slug=? LIMIT 1', [slug]);
    if (existing.length) slug = slug + '-' + Date.now().toString(36);

    const uuid = uuidv4();
    const pubAt = status === 'published' ? (published_at || new Date()) : null;

    await query(
      `INSERT INTO articles
         (uuid, slug, title, excerpt, content, meta_title, meta_description,
          keywords, og_image, cover_image, status, published_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid, slug, title, excerpt, content, meta_title, meta_description,
       keywords, og_image, cover_image, status, pubAt, req.admin?.id || null]
    );
    const [article] = await query('SELECT * FROM articles WHERE uuid=? LIMIT 1', [uuid]);
    res.json({ success: true, data: article });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// PUT /api/admin/articles/:id — update
router.put('/admin/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, content, excerpt, slug: slugInput,
      meta_title, meta_description, keywords,
      og_image, cover_image, status, published_at,
    } = req.body;

    const rows = await query('SELECT * FROM articles WHERE id=? LIMIT 1', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบบทความ' });

    const art = rows[0];
    const newSlug = slugInput ? toSlug(slugInput) : art.slug;
    const newStatus = status || art.status;
    let pubAt = art.published_at;
    if (newStatus === 'published' && !art.published_at) pubAt = published_at || new Date();
    if (newStatus === 'draft') pubAt = null;

    await query(
      `UPDATE articles SET
         title=COALESCE(?,title), slug=?, content=COALESCE(?,content),
         excerpt=COALESCE(?,excerpt), meta_title=COALESCE(?,meta_title),
         meta_description=COALESCE(?,meta_description), keywords=COALESCE(?,keywords),
         og_image=COALESCE(?,og_image), cover_image=COALESCE(?,cover_image),
         status=?, published_at=?
       WHERE id=?`,
      [title, newSlug, content, excerpt, meta_title, meta_description,
       keywords, og_image, cover_image, newStatus, pubAt, id]
    );
    const [updated] = await query('SELECT * FROM articles WHERE id=? LIMIT 1', [id]);
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /api/admin/articles/:id
router.delete('/admin/:id', authAdmin, async (req, res) => {
  try {
    const rows = await query('SELECT id FROM articles WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบบทความ' });
    await query('DELETE FROM articles WHERE id=?', [req.params.id]);
    res.json({ success: true, message: 'ลบบทความแล้ว' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
