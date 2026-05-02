'use strict';
const express = require('express');
const router  = express.Router();
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
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(20, parseInt(req.query.limit) || 10);
    const offset = (page - 1) * limit;

    const rows = await query(
      `SELECT id, slug, title, summary, cover_image, og_image,
              author, tags, views, status, created_at, updated_at
       FROM articles
       WHERE status='published'
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM articles WHERE status='published'`
    );
    res.json({ success: true, data: rows, total, page, limit });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/articles/:slug — single article + increment view
router.get('/:slug([^/]+)', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM articles WHERE slug=? AND status='published' LIMIT 1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบบทความ' });

    // increment view (fire-and-forget)
    query('UPDATE articles SET views=views+1 WHERE id=?', [rows[0].id]).catch(() => {});

    // related articles
    const related = await query(
      `SELECT slug, title, summary, cover_image, created_at
       FROM articles WHERE status='published' AND id != ?
       ORDER BY created_at DESC LIMIT 4`,
      [rows[0].id]
    );
    res.json({ success: true, data: rows[0], related });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN ────────────────────────────────────────────────────────────────

// GET /api/articles/admin/list — list all (admin)
router.get('/admin/list', authAdmin, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const status = req.query.status || null;

    const where  = status ? 'WHERE status=?' : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    const rows = await query(
      `SELECT id, slug, title, summary, author, tags, status, views, created_at, updated_at
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

// GET /api/articles/admin/:id — get single article by ID (for edit form)
router.get('/admin/:id', authAdmin, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM articles WHERE id=? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบบทความ' });
    res.json({ success: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/articles/admin — create
router.post('/admin', authAdmin, async (req, res) => {
  try {
    const {
      title, content,
      summary    = '',
      author     = 'Admin',
      tags       = '',
      cover_image = '',
      og_image    = '',
      status     = 'draft',
    } = req.body;

    if (!title)   return res.status(400).json({ success: false, message: 'title จำเป็น' });
    if (!content) return res.status(400).json({ success: false, message: 'content จำเป็น' });

    let slug = toSlug(title);
    const existing = await query('SELECT id FROM articles WHERE slug=? LIMIT 1', [slug]);
    if (existing.length) slug = slug + '-' + Date.now().toString(36);

    await query(
      `INSERT INTO articles (slug, title, summary, content, cover_image, og_image,
                             author, tags, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [slug, title, summary, content, cover_image, og_image, author, tags, status]
    );
    const [article] = await query('SELECT * FROM articles WHERE slug=? LIMIT 1', [slug]);
    res.json({ success: true, data: article });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// PUT /api/articles/admin/:id — update
router.put('/admin/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await query('SELECT * FROM articles WHERE id=? LIMIT 1', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบบทความ' });

    const art = rows[0];
    const {
      title       = art.title,
      content     = art.content,
      summary     = art.summary,
      author      = art.author,
      tags        = art.tags,
      cover_image = art.cover_image,
      og_image    = art.og_image,
      status      = art.status,
      slug: slugInput,
    } = req.body;

    const newSlug = slugInput ? toSlug(slugInput) : art.slug;

    await query(
      `UPDATE articles SET
         title=?, slug=?, content=?, summary=?, author=?,
         tags=?, cover_image=?, og_image=?, status=?
       WHERE id=?`,
      [title, newSlug, content, summary, author, tags, cover_image, og_image, status, id]
    );
    const [updated] = await query('SELECT * FROM articles WHERE id=? LIMIT 1', [id]);
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /api/articles/admin/:id
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
