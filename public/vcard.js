/* Shared vCard logic: used by the server (require) and the browser (window.VCard).
 * - normalize(): validates/sanitizes user input (server trusts only its output)
 * - build():     vCard 3.0 text (.vcf / static QR payload)
 * - renderPage(): the hosted contact-card page (no scripts; safe to serve with a strict CSP)
 */
(function (root) {
  'use strict';

  var PHONE_TYPES = {
    main: { label: 'Main', vcf: 'VOICE,PREF' },
    mobile: { label: 'Mobile', vcf: 'CELL' },
    work: { label: 'Work', vcf: 'WORK,VOICE' },
    home: { label: 'Home', vcf: 'HOME,VOICE' },
    fax: { label: 'Fax', vcf: 'FAX' },
  };
  var MAX_ITEMS = 5;
  var TEMPLATES = {
    classic: 'Classic',
    banner: 'Banner',
    bold: 'Bold',
    bubbles: 'Bubbles',
    cover: 'Cover',
  };
  var SOCIALS = {
    linkedin: { label: 'LinkedIn', host: 'linkedin.com' },
    instagram: { label: 'Instagram', host: 'instagram.com' },
    facebook: { label: 'Facebook', host: 'facebook.com' },
    x: { label: 'X', host: 'x.com' },
    youtube: { label: 'YouTube', host: 'youtube.com' },
  };
  var MAX_PHOTO = 300 * 1024; // data-URL length
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

  function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
  function list(v) { return Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []; }

  function normUrl(v) {
    var s = str(v, 300);
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    try {
      var u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
    } catch (e) { return ''; }
  }

  function validDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d <= new Date();
  }

  /** Returns { card, errors[] }. */
  function normalize(input) {
    input = input || {};
    var errors = [];
    var card = {
      firstName: str(input.firstName, 80),
      lastName: str(input.lastName, 80),
      company: str(input.company, 120),
      jobTitle: str(input.jobTitle, 120),
      birthday: str(input.birthday, 10),
      address: str(input.address, 300),
      // About text keeps line breaks (other control characters are removed)
      about: String(input.about == null ? '' : input.about).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
        .replace(/\n{3,}/g, '\n\n').trim().slice(0, 400),
      template: TEMPLATES[input.template] ? input.template : 'classic',
      socials: {},
      color: HEX.test(input.color || '') ? input.color.toLowerCase() : '#4f46e5',
      photo: '',
      phones: [],
      emails: [],
      websites: [],
    };
    if (card.birthday && !validDate(card.birthday)) { errors.push('Date of birth is not a valid past date'); card.birthday = ''; }

    if (input.photo) {
      if (typeof input.photo === 'string' && input.photo.length <= MAX_PHOTO && PHOTO.test(input.photo)) card.photo = input.photo;
      else errors.push('Photo must be a JPEG/PNG/WebP image under 300 KB');
    }
    list(input.phones).forEach(function (p) {
      var number = str(p && p.number, 30);
      if (!number) return;
      if (!/^\+?[0-9][0-9 ()\-.]{2,24}$/.test(number)) { errors.push('Invalid phone number: ' + number); return; }
      card.phones.push({ type: PHONE_TYPES[p.type] ? p.type : 'main', number: number });
    });
    list(input.emails).forEach(function (e) {
      var v = str(e, 254);
      if (!v) return;
      if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) { errors.push('Invalid email: ' + v); return; }
      card.emails.push(v);
    });
    list(input.websites).forEach(function (w) {
      if (!str(w, 300)) return;
      var v = normUrl(w);
      if (!v) { errors.push('Invalid website: ' + str(w, 60)); return; }
      card.websites.push(v);
    });
    var socials = input.socials && typeof input.socials === 'object' ? input.socials : {};
    Object.keys(SOCIALS).forEach(function (k) {
      var raw = str(socials[k], 300);
      if (!raw) return;
      // accept a bare handle ("@name" or "name") as well as a full link
      var handle = /^@?[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(raw) && (raw[0] === '@' || !/\.[a-z]{2,}$/i.test(raw));
      if (handle) raw = SOCIALS[k].host + '/' + (k === 'linkedin' ? 'in/' : k === 'youtube' ? '@' : '') + raw.replace(/^@/, '');
      var v = normUrl(raw);
      if (!v) { errors.push('Invalid ' + SOCIALS[k].label + ' link'); return; }
      card.socials[k] = v;
    });
    if (!card.firstName && !card.lastName && !card.company) errors.push('Enter a first name, last name or company');
    return { card: card, errors: errors };
  }

  function fullName(c) { return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || 'Contact'; }

  // ---------------- vCard 3.0 text ----------------
  function vesc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function fold(line) { // RFC 6350 line folding at 75 chars
    if (line.length <= 75) return line;
    var out = line.slice(0, 75), rest = line.slice(75);
    while (rest.length) { out += '\r\n ' + rest.slice(0, 74); rest = rest.slice(74); }
    return out;
  }

  function build(c, opts) {
    opts = opts || {};
    var L = ['BEGIN:VCARD', 'VERSION:3.0',
      'N:' + vesc(c.lastName) + ';' + vesc(c.firstName) + ';;;',
      'FN:' + vesc(fullName(c))];
    if (c.company) L.push('ORG:' + vesc(c.company));
    if (c.jobTitle) L.push('TITLE:' + vesc(c.jobTitle));
    (c.phones || []).forEach(function (p) { L.push('TEL;TYPE=' + (PHONE_TYPES[p.type] || PHONE_TYPES.main).vcf + ':' + p.number); });
    (c.emails || []).forEach(function (e, i) { L.push('EMAIL;TYPE=INTERNET' + (i === 0 ? ',PREF' : '') + ':' + e); });
    (c.websites || []).forEach(function (w) { L.push('URL:' + w); });
    if (c.address) L.push('ADR;TYPE=WORK:;;' + vesc(c.address) + ';;;;');
    if (c.birthday) L.push('BDAY:' + c.birthday);
    if (c.about) L.push('NOTE:' + vesc(c.about));
    Object.keys(SOCIALS).forEach(function (k) {
      if (c.socials && c.socials[k]) L.push('X-SOCIALPROFILE;TYPE=' + k + ':' + c.socials[k]);
    });
    if (opts.photo !== false && c.photo) {
      var m = /^data:image\/(\w+);base64,(.+)$/.exec(c.photo);
      if (m) L.push('PHOTO;ENCODING=b;TYPE=' + m[1].toUpperCase() + ':' + m[2]);
    }
    if (opts.source) L.push('SOURCE:' + opts.source);
    L.push('END:VCARD');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  // ---------------- hosted card page (templates) ----------------
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }

  // colour helpers
  function rgbOf(hex) { return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); }); }
  function hexOf(rgb) { return '#' + rgb.map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join(''); }
  function mix(hex, other, t) { var a = rgbOf(hex), b = rgbOf(other); return hexOf(a.map(function (v, i) { return v + (b[i] - v) * t; })); }
  function lum(hex) {
    var c = rgbOf(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function onColor(hex) { return lum(hex) > 0.45 ? '#111827' : '#ffffff'; }
  function hueShift(hex, deg) {
    var c = rgbOf(hex).map(function (v) { return v / 255; });
    var max = Math.max.apply(null, c), min = Math.min.apply(null, c), l = (max + min) / 2, s = 0, hh = 0, d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      hh = max === c[0] ? (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0) : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
      hh *= 60;
    }
    hh = (hh + deg + 360) % 360; s = Math.max(s, 0.55);
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
    return hexOf([f(hh / 360 + 1 / 3), f(hh / 360), f(hh / 360 - 1 / 3)].map(function (v) { return v * 255; }));
  }

  function initials(c) { return (((c.firstName || '')[0] || '') + ((c.lastName || '')[0] || '') || (c.company || '?')[0]).toUpperCase(); }
  function prettyDate(s) {
    var d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  var ICONS = {
    phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
    fax: '<path d="M19 8H5a3 3 0 0 0-3 3v6h4v4h12v-4h4v-6a3 3 0 0 0-3-3zm-3 11H8v-5h8v5zm3-7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-1-9H6v4h12V3z"/>',
    mail: '<path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v.4l8 5 8-5V7H4zm16 2.75-8 5-8-5V17h16V9.75z"/>',
    web: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.3-3.9A8 8 0 0 1 18.9 8zM12 4c.8 1.1 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.9 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.4a16 16 0 0 0 0 4H4.3zm.8 2h3a15.7 15.7 0 0 0 1.3 3.9A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.3-3.9C8.9 5.3 8.5 6.6 8.1 8zM12 20c-.8-1.1-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.9-1.9 4zm2.3-6H9.7a14 14 0 0 1 0-4h4.6a14 14 0 0 1 0 4zm.3 5.9c.6-1.2 1-2.5 1.3-3.9h3a8 8 0 0 1-4.3 3.9zm1.7-5.9a16 16 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4z"/>',
    pin: '<path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>',
    cake: '<path d="M12 6a2 2 0 0 0 2-2c0-.38-.1-.73-.29-1.03L12 0l-1.71 2.97A2 2 0 0 0 12 6zm6 3h-5V7h-2v2H6a3 3 0 0 0-3 3v1.54c0 1.08.88 1.96 1.96 1.96.52 0 1.02-.2 1.38-.57l2.14-2.13 2.13 2.13a2 2 0 0 0 2.77 0l2.14-2.13 2.13 2.13c.37.37.86.57 1.38.57 1.08 0 1.97-.88 1.97-1.96V12a3 3 0 0 0-3-3zm1 7.97c-.77 0-1.49-.3-2.03-.84l-1.07-1.07-1.08 1.07a3.01 3.01 0 0 1-4.24 0l-1.07-1.07-1.08 1.07A2.87 2.87 0 0 1 5 16.97V21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4.03z"/>',
    save: '<path d="M15 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
    linkedin: '<path d="M6.94 5a2 2 0 1 1-4-.002 2 2 0 0 1 4 .002zM7 8.48H3V21h4V8.48zm6.32 0H9.34V21h3.94v-6.57c0-3.66 4.77-4 4.77 0V21H22v-7.93c0-6.17-7.06-5.94-8.72-2.91l.04-1.68z"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.3"/>',
    facebook: '<path d="M14 8h3V4h-3c-2.8 0-4.5 1.8-4.5 4.6V11H7v4h2.5v7h4v-7H17l.5-4h-4V8.8c0-.5.3-.8.5-.8z"/>',
    x: '<path d="M4 3h4.6l4 5.6L17.4 3H20l-6.1 7.3L21 21h-4.6l-4.4-6.1L6.7 21H4l6.7-7.9z"/>',
    youtube: '<path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8zM10 15.5v-7l6 3.5z"/>',
  };
  function icon(name, size) {
    size = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" aria-hidden="true">' + ICONS[name] + '</svg>';
  }
  function link(href, ext) { return href ? ' href="' + h(href) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') : ''; }


  // ---------------- Android "Add contact" intent ----------------
  // Chrome / Samsung Internet open the phone's own Add-contact screen, pre-filled, from an
  // intent: link (ContactsContract.Intents.Insert extras). That screen can't take a photo,
  // websites or birthday, so those go into Notes. browser_fallback_url is used by browsers
  // that can't handle the intent.
  var ANDROID_PHONE_TYPE = { main: 12, mobile: 2, work: 3, home: 1, fax: 4 };
  function androidIntent(c, fallbackUrl) {
    var ex = [], enc = encodeURIComponent;
    function put(kind, key, val) { if (val !== '' && val != null) ex.push(kind + '.' + key + '=' + enc(String(val))); }
    put('S', 'name', fullName(c));
    put('S', 'company', c.company);
    put('S', 'job_title', c.jobTitle);
    put('S', 'postal', c.address);
    ['', 'secondary_', 'tertiary_'].forEach(function (pre, i) {
      var p = (c.phones || [])[i];
      if (p) { put('S', pre + 'phone', p.number); put('i', pre + 'phone_type', ANDROID_PHONE_TYPE[p.type] || 12); }
      put('S', pre + 'email', (c.emails || [])[i]);
    });
    var notes = [];
    if (c.about) notes.push(c.about);
    (c.websites || []).forEach(function (w) { notes.push('Website: ' + w); });
    Object.keys(SOCIALS).forEach(function (k) { if (c.socials && c.socials[k]) notes.push(SOCIALS[k].label + ': ' + c.socials[k]); });
    if (c.birthday) notes.push('Birthday: ' + prettyDate(c.birthday));
    (c.phones || []).slice(3).forEach(function (p) { notes.push('Phone: ' + p.number); });
    (c.emails || []).slice(3).forEach(function (e) { notes.push('Email: ' + e); });
    put('S', 'notes', notes.join('\n'));
    put('S', 'browser_fallback_url', fallbackUrl);
    return 'intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/contact;' + ex.join(';') + ';end';
  }

  // Everything the templates need, computed once.
  function model(c, vcfHref, opts) {
    opts = opts || {};
    var color = HEX.test(c.color || '') ? c.color : '#4f46e5';
    var m = {
      c: c, name: fullName(c), job: c.jobTitle || '', company: c.company || '', about: c.about || '', vcf: vcfHref,
      color: color,
      fg: onColor(color),                                             // text on the card colour
      ic: lum(color) > 0.4 ? mix(color, '#000000', 0.45) : color,     // readable accent on white
      tint: mix(color, '#ffffff', 0.86),                               // pale background of the colour
      c2: hueShift(color, 38),                                         // companion hue for decorations
      quick: [], rows: [], socials: [],
    };
    m.sub = [m.job, m.company].filter(Boolean).join(' · ');
    var tel = function (n) { return 'tel:' + n.replace(/[^\d+]/g, ''); };
    if (c.phones && c.phones[0]) m.quick.push({ href: tel(c.phones[0].number), icon: 'phone', label: 'Call' });
    if (c.emails && c.emails[0]) m.quick.push({ href: 'mailto:' + c.emails[0], icon: 'mail', label: 'Email' });
    if (c.websites && c.websites[0]) m.quick.push({ href: c.websites[0], icon: 'web', label: 'Website', ext: true });
    (c.phones || []).forEach(function (p) {
      var t = PHONE_TYPES[p.type] || PHONE_TYPES.main;
      m.rows.push({ href: tel(p.number), icon: p.type === 'fax' ? 'fax' : 'phone', value: p.number, label: t.label === 'Main' ? 'Phone' : t.label });
    });
    (c.emails || []).forEach(function (e) { m.rows.push({ href: 'mailto:' + e, icon: 'mail', value: e, label: 'Email' }); });
    (c.websites || []).forEach(function (w) { m.rows.push({ href: w, icon: 'web', value: w.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), label: 'Website', ext: true }); });
    if (c.address) m.rows.push({ href: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address), icon: 'pin', value: c.address, label: 'Address', ext: true });
    if (c.birthday) m.rows.push({ icon: 'cake', value: prettyDate(c.birthday), label: 'Birthday' });
    Object.keys(SOCIALS).forEach(function (k) {
      if (c.socials && c.socials[k]) m.socials.push({ href: c.socials[k], icon: k, label: SOCIALS[k].label });
    });
    m.avatar = function (cls) {
      return c.photo ? '<img class="' + (cls || 'avatar') + '" src="' + h(c.photo) + '" alt="">'
        : '<div class="' + (cls || 'avatar') + ' ph">' + h(initials(c)) + '</div>';
    };
    m.socialHtml = function (cls) {
      return m.socials.length ? '<nav class="soc ' + (cls || '') + '">' + m.socials.map(function (s) {
        return '<a' + link(s.href, true) + ' aria-label="' + s.label + '" title="' + s.label + '">' + icon(s.icon, 22) + '</a>';
      }).join('') + '</nav>' : '';
    };
    m.aboutHtml = function (cls) { return m.about ? '<p class="about ' + (cls || '') + '">' + h(m.about) + '</p>' : ''; };
    m.saveHtml = '<a class="save"' + link(opts.addHref || vcfHref) + '>' + icon('save') + 'Add to contacts</a>';
    // On Android the button opens the native screen (no photo), so also offer the full file
    m.altHtml = opts.addHref ? '<p class="alt"><a' + link(vcfHref) + '>Download contact file (.vcf) with photo</a></p>' : '';
    return m;
  }

  var BASE_CSS =
    '*{box-sizing:border-box}html,body{margin:0}body{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2030}' +
    'a{color:inherit;text-decoration:none}svg{display:block;flex-shrink:0}' +
    '.wrap{max-width:480px;margin:0 auto;min-height:100vh;position:relative;overflow:hidden;padding-bottom:100px}' +
    'h1{margin:0;line-height:1.2;overflow-wrap:anywhere}p{margin:0}.about{white-space:pre-line;overflow-wrap:anywhere}' +
    '.avatar{display:block;border-radius:50%;object-fit:cover;background:#fff}.ph{display:grid;place-items:center;font-weight:700}' +
    '.soc{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}.soc a{width:44px;height:44px;border-radius:50%;display:grid;place-items:center}' +
    '.save{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(448px,calc(100% - 32px));display:flex;align-items:center;justify-content:center;gap:8px;padding:15px;border-radius:14px;font-weight:700;box-shadow:0 6px 20px rgba(16,24,40,.25);z-index:5}' +
    '.row b{font-weight:500;overflow-wrap:anywhere;display:block}' +
    '.alt{position:relative;text-align:center;font-size:13px;margin:14px 16px 0;width:100%}.alt a{text-decoration:underline;opacity:.75}';

  // Each template returns [css, bodyHtml].
  var RENDER = {
    classic: function (m) {
      var css = 'body{background:#eef0f5}.wrap{background:#fff}' +
        '.hero{background:' + m.color + ';color:' + m.fg + ';text-align:center;padding:36px 20px 64px}' +
        '.hero .avatar{width:112px;height:112px;border:4px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.18);margin:0 auto 14px}.ph{font-size:38px;color:' + m.ic + '}' +
        'h1{font-size:26px}.sub{margin-top:6px;opacity:.85}' +
        '.quick{display:flex;justify-content:center;gap:12px;margin:-36px 16px 8px;position:relative}' +
        '.quick a{flex:0 1 96px;display:grid;justify-items:center;gap:4px;padding:12px 6px;background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(16,24,40,.12);font-size:13px;font-weight:600;color:#1c2030}' +
        '.quick svg,.row svg{color:' + m.ic + '}.about{padding:12px 24px 0;color:#4b5563;text-align:center}' +
        '.rows{padding:8px 16px}.row{display:flex;gap:14px;align-items:center;padding:14px 4px;border-bottom:1px solid #eceef3}.row:last-child{border-bottom:0}' +
        '.row span{font-size:13px;color:#6a7187}.soc{margin:8px 0}.soc a{background:' + m.tint + ';color:' + m.ic + '}' +
        '.save{background:' + m.color + ';color:' + m.fg + '}';
      var body = '<header class="hero">' + m.avatar() + '<h1>' + h(m.name) + '</h1>' + (m.sub ? '<p class="sub">' + h(m.sub) + '</p>' : '') + '</header>' +
        (m.quick.length ? '<nav class="quick">' + m.quick.map(function (q) { return '<a' + link(q.href, q.ext) + '>' + icon(q.icon) + h(q.label) + '</a>'; }).join('') + '</nav>' : '') +
        m.aboutHtml() +
        '<main class="rows">' + m.rows.map(function (r) {
          var inner = icon(r.icon) + '<div><b>' + h(r.value) + '</b><span>' + h(r.label) + '</span></div>';
          return r.href ? '<a class="row"' + link(r.href, r.ext) + '>' + inner + '</a>' : '<div class="row">' + inner + '</div>';
        }).join('') + '</main>' + m.socialHtml() + m.altHtml;
      return [css, body];
    },

    banner: function (m) {
      var css = 'body,.wrap{background:#e8ecf1}.wrap{padding-top:74px}' +
        '.panel{margin:0 16px;background:' + m.color + ';color:' + m.fg + ';border-radius:20px;padding:70px 16px 16px;text-align:center;position:relative;box-shadow:0 8px 24px rgba(16,24,40,.12)}' +
        '.panel .avatar{position:absolute;top:-62px;left:50%;transform:translateX(-50%);width:124px;height:124px;border:5px solid #fff}.ph{font-size:40px;color:' + m.ic + '}' +
        'h1{font-size:24px;font-weight:700}.sub{font-size:14px;margin-top:4px;opacity:.9}.about{font-size:14px;opacity:.92;margin-top:12px}' +
        '.bar{display:flex;background:#fff;border-radius:10px;overflow:hidden;margin-top:16px}' +
        '.bar a{flex:1;display:flex;gap:6px;align-items:center;justify-content:center;padding:11px 4px;color:' + m.ic + ';font-size:13px;font-weight:600}.bar a+a{border-left:1px solid #e5e7eb}' +
        '.rows{margin:10px 16px 0}.row{display:flex;gap:16px;align-items:center;padding:14px 4px;border-bottom:1px solid #d6dbe3}.row:last-child{border-bottom:0}' +
        '.ic{width:46px;height:46px;border-radius:50%;background:#fff;display:grid;place-items:center;color:' + m.ic + ';flex-shrink:0;box-shadow:0 1px 4px rgba(16,24,40,.08)}' +
        '.row div span{display:block;font-size:12px;color:#8a93a6}.soc{margin:16px}.soc a{background:#fff;color:' + m.ic + '}' +
        '.save{background:' + m.color + ';color:' + m.fg + '}';
      var body = '<section class="panel">' + m.avatar() + '<h1>' + h(m.name) + '</h1>' + (m.sub ? '<p class="sub">' + h(m.sub) + '</p>' : '') + m.aboutHtml() +
        (m.quick.length ? '<nav class="bar">' + m.quick.map(function (q) { return '<a' + link(q.href, q.ext) + '>' + icon(q.icon, 16) + h(q.label === 'Call' ? 'Phone' : q.label) + '</a>'; }).join('') + '</nav>' : '') +
        '</section><main class="rows">' + m.rows.map(function (r) {
          var inner = '<span class="ic">' + icon(r.icon) + '</span><div><span>' + h(r.label) + '</span><b>' + h(r.value) + '</b></div>';
          return r.href ? '<a class="row"' + link(r.href, r.ext) + '>' + inner + '</a>' : '<div class="row">' + inner + '</div>';
        }).join('') + '</main>' + m.socialHtml() + m.altHtml;
      return [css, body];
    },

    bold: function (m) {
      var cut = 'polygon(14px 0,calc(100% - 14px) 0,100% 14px,100% calc(100% - 14px),calc(100% - 14px) 100%,14px 100%,0 calc(100% - 14px),0 14px)';
      var css = 'body,.wrap{background:' + m.color + '}.wrap{color:' + m.fg + ';text-align:center;padding:40px 20px 0}' +
        '.wrap .avatar{width:150px;height:150px;border:4px solid #fff;margin:0 auto}.ph{font-size:48px;color:' + m.ic + '}' +
        'h1{font-size:30px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;line-height:1.1;margin:20px 0 8px}' +
        '.sub{text-transform:uppercase;letter-spacing:.06em;font-size:15px}.about{margin-top:12px;opacity:.92}' +
        '.boxes{margin-top:22px}.box{display:block;background:#fff;color:#0f172a;margin:0 0 12px;padding:14px 18px;clip-path:' + cut + '}' +
        '.box span{display:block;font-weight:800;text-transform:uppercase;letter-spacing:.05em;font-size:15px}.box b{font-weight:400;font-size:17px;overflow-wrap:anywhere}' +
        '.foot{background:#fff;color:#0f172a;margin:24px -20px 0;padding:24px 22px 110px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}' +
        '.foot h2{margin:0;color:' + m.ic + ';font-size:21px;font-weight:800;text-transform:uppercase;letter-spacing:.02em}' +
        '.soc{gap:10px}.soc a{background:#111827;color:#fff}.wrap{padding-bottom:0}' +
        '.save{background:#111827;color:#fff}';
      var body = m.avatar() + '<h1>' + h(m.name) + '</h1>' + (m.job ? '<p class="sub">' + h(m.job) + '</p>' : '') +
        (m.company ? '<p class="sub" style="opacity:.85;font-size:13px;margin-top:4px">' + h(m.company) + '</p>' : '') + m.aboutHtml() +
        '<main class="boxes">' + m.rows.map(function (r) {
          var inner = '<span>' + h(r.label) + '</span><b>' + h(r.value) + '</b>';
          return r.href ? '<a class="box"' + link(r.href, r.ext) + '>' + inner + '</a>' : '<div class="box">' + inner + '</div>';
        }).join('') + '</main>' +
        '<footer class="foot"><h2>Let\'s connect</h2>' + m.socialHtml() + m.altHtml + '</footer>';
      return [css, body];
    },

    bubbles: function (m) {
      var css = 'body{background:#f4f5f7}.wrap{background:#fff}' +
        '.b1{position:absolute;top:-110px;left:-70px;width:360px;height:230px;border-radius:50%;background:linear-gradient(120deg,' + m.color + ',' + m.c2 + ');transform:rotate(-10deg)}' +
        '.b2{position:absolute;top:-50px;right:-60px;width:170px;height:170px;border-radius:50%;background:' + m.c2 + ';opacity:.75}' +
        '.b3{position:absolute;bottom:-70px;right:-80px;width:240px;height:170px;border-radius:50%;background:linear-gradient(200deg,' + m.c2 + ',' + m.color + ');opacity:.9}' +
        '.b4{position:absolute;bottom:40px;left:-30px;width:70px;height:70px;border-radius:50%;background:' + m.tint + '}' +
        '.dots{position:absolute;width:44px;height:24px;background-image:radial-gradient(#c5cad3 2px,transparent 2.6px);background-size:11px 11px}' +
        '.d1{right:22px;top:150px}.d2{left:-14px;top:380px}' +
        '.stripe{position:absolute;left:-10px;top:290px;width:46px;height:46px;border-radius:50%;background:repeating-linear-gradient(135deg,#d7dbe2 0 2px,transparent 2px 7px)}' +
        '.top{position:relative;padding:92px 24px 0;text-align:center}' +
        '.av{position:relative;display:inline-block}.av .avatar{width:156px;height:156px;border:6px solid #fff;box-shadow:0 8px 24px rgba(16,24,40,.15)}.ph{font-size:50px;color:' + m.ic + ';background:' + m.tint + '}' +
        '.av:after{content:"";position:absolute;right:-6px;bottom:8px;width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 30% 30%,' + mix(m.c2, '#ffffff', 0.5) + ',' + m.c2 + ')}' +
        'h1{font-size:27px;font-weight:800;color:#1f2937;margin-top:16px}.job{color:' + m.ic + ';font-weight:600;font-size:17px;margin-top:2px}' +
        '.co{color:#4b5563;margin-top:2px}.about{color:#6b7280;font-size:14px;margin:12px auto 0;max-width:340px}' +
        '.rows{position:relative;padding:20px 40px 8px}.row{display:flex;gap:16px;align-items:center;padding:7px 0}' +
        '.ic{width:42px;height:42px;border-radius:50%;background:#eef0f3;color:#4b5563;display:grid;place-items:center;flex-shrink:0}' +
        '.row b{color:#374151}.soc{position:relative;margin:10px 0}.soc a{background:#eef0f3;color:' + m.ic + '}' +
        '.save{background:linear-gradient(90deg,' + m.color + ',' + m.c2 + ');color:' + onColor(mix(m.color, m.c2, 0.5)) + '}';
      var body = '<div class="b1"></div><div class="b2"></div><div class="b3"></div><div class="b4"></div>' +
        '<div class="dots d1"></div><div class="dots d2"></div><div class="stripe"></div>' +
        '<header class="top"><div class="av">' + m.avatar() + '</div><h1>' + h(m.name) + '</h1>' +
        (m.job ? '<p class="job">' + h(m.job) + '</p>' : '') + (m.company ? '<p class="co">' + h(m.company) + '</p>' : '') + m.aboutHtml() + '</header>' +
        '<main class="rows">' + m.rows.map(function (r) {
          var inner = '<span class="ic">' + icon(r.icon) + '</span><b>' + h(r.value) + '</b>';
          return r.href ? '<a class="row" title="' + h(r.label) + '"' + link(r.href, r.ext) + '>' + inner + '</a>' : '<div class="row" title="' + h(r.label) + '">' + inner + '</div>';
        }).join('') + '</main>' + m.socialHtml() + m.altHtml;
      return [css, body];
    },

    cover: function (m) {
      var css = 'body{background:#eef0f5}.wrap{background:#fff}' +
        '.cover{position:relative;height:310px;background:linear-gradient(135deg,' + m.color + ',' + m.c2 + ')}' +
        '.cover .avatar{width:100%;height:100%;border-radius:0;object-position:50% 22%}.cover .ph{font-size:84px;background:transparent;color:' + m.fg + ';opacity:.9}' +
        '.wave{position:absolute;left:0;bottom:-1px;width:100%;height:64px}' +
        '.body{padding:4px 26px 0}.id{border-left:2px dotted #9ca3af;padding:2px 0 2px 16px;margin:6px 0 16px}' +
        'h1{font-size:27px;font-weight:800;color:#111827}.job{color:#374151;margin-top:2px}.co{font-style:italic;color:#4b5563}' +
        '.about{color:#4b5563;font-size:15px;margin-bottom:12px}' +
        '.row{display:flex;gap:12px;align-items:center;padding:8px 0}.ic{width:36px;height:36px;border-radius:50%;background:' + m.tint + ';color:' + m.ic + ';display:grid;place-items:center;flex-shrink:0}' +
        '.row b{color:#374151}.soc{justify-content:flex-start;margin:14px 0}.soc a{background:' + m.tint + ';color:' + m.ic + '}' +
        '.save{background:' + m.color + ';color:' + m.fg + '}';
      var body = '<header class="cover">' + m.avatar() +
        '<svg class="wave" viewBox="0 0 400 64" preserveAspectRatio="none" aria-hidden="true">' +
        '<path d="M0 38 C 90 74, 190 2, 290 24 S 400 30, 400 30 V64 H0Z" fill="#fff"/>' +
        '<path d="M0 38 C 90 74, 190 2, 290 24 S 400 30, 400 30" fill="none" stroke="' + m.color + '" stroke-width="6"/></svg></header>' +
        '<main class="body"><div class="id"><h1>' + h(m.name) + '</h1>' + (m.job ? '<p class="job">' + h(m.job) + '</p>' : '') +
        (m.company ? '<p class="co">' + h(m.company) + '</p>' : '') + '</div>' + m.aboutHtml() +
        m.rows.map(function (r) {
          var inner = '<span class="ic">' + icon(r.icon, 18) + '</span><b>' + h(r.value) + '</b>';
          return r.href ? '<a class="row" title="' + h(r.label) + '"' + link(r.href, r.ext) + '>' + inner + '</a>' : '<div class="row" title="' + h(r.label) + '">' + inner + '</div>';
        }).join('') + m.socialHtml() + m.altHtml + '</main>';
      return [css, body];
    },
  };

  /** Full HTML document for the hosted card. vcfHref: link for "Add to contacts". */
  function renderPage(c, vcfHref, opts) {
    var m = model(c, vcfHref, opts);
    var out = (RENDER[c.template] || RENDER.classic)(m);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="theme-color" content="' + m.color + '">' +
      '<title>' + h(m.name) + '</title><style>' + BASE_CSS + out[0] + '</style></head>' +
      '<body><div class="wrap">' + out[1] + m.saveHtml + '</div></body></html>';
  }

  var api = { androidIntent: androidIntent, PHONE_TYPES: PHONE_TYPES, TEMPLATES: TEMPLATES, SOCIALS: SOCIALS, icon: icon,
    palette: function (hex) { return { c2: hueShift(hex, 38), tint: mix(hex, '#ffffff', 0.86) }; }, MAX_ITEMS: MAX_ITEMS, normalize: normalize, build: build, renderPage: renderPage, fullName: fullName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VCard = api;
})(typeof window !== 'undefined' ? window : this);
