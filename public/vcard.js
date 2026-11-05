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
    if (opts.photo !== false && c.photo) {
      var m = /^data:image\/(\w+);base64,(.+)$/.exec(c.photo);
      if (m) L.push('PHOTO;ENCODING=b;TYPE=' + m[1].toUpperCase() + ':' + m[2]);
    }
    if (opts.source) L.push('SOURCE:' + opts.source);
    L.push('END:VCARD');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  // ---------------- hosted card page ----------------
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function onColor(hex) {
    var rgb = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.45 ? '#111827' : '#ffffff';
  }
  function initials(c) { return ((c.firstName || '')[0] || '') + ((c.lastName || '')[0] || '') || (c.company || '?')[0]; }
  function prettyDate(s) {
    var d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  var ICONS = {
    phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
    mail: '<path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v.4l8 5 8-5V7H4zm16 2.75-8 5-8-5V17h16V9.75z"/>',
    web: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.3-3.9A8 8 0 0 1 18.9 8zM12 4c.8 1.1 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.9 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.4a16 16 0 0 0 0 4H4.3zm.8 2h3a15.7 15.7 0 0 0 1.3 3.9A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.3-3.9C8.9 5.3 8.5 6.6 8.1 8zM12 20c-.8-1.1-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.9-1.9 4zm2.3-6H9.7a14 14 0 0 1 0-4h4.6a14 14 0 0 1 0 4zm.3 5.9c.6-1.2 1-2.5 1.3-3.9h3a8 8 0 0 1-4.3 3.9zm1.7-5.9a16 16 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4z"/>',
    pin: '<path d="M12 2a7 7 0 0 1 7 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 0 1 7-7zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>',
    cake: '<path d="M12 6a2 2 0 0 0 2-2c0-.38-.1-.73-.29-1.03L12 0l-1.71 2.97A2 2 0 0 0 12 6zm6 3h-5V7h-2v2H6a3 3 0 0 0-3 3v1.54c0 1.08.88 1.96 1.96 1.96.52 0 1.02-.2 1.38-.57l2.14-2.13 2.13 2.13a2 2 0 0 0 2.77 0l2.14-2.13 2.13 2.13c.37.37.86.57 1.38.57 1.08 0 1.97-.88 1.97-1.96V12a3 3 0 0 0-3-3zm1 7.97c-.77 0-1.49-.3-2.03-.84l-1.07-1.07-1.08 1.07a3.01 3.01 0 0 1-4.24 0l-1.07-1.07-1.08 1.07A2.87 2.87 0 0 1 5 16.97V21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4.03z"/>',
    save: '<path d="M15 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' + ICONS[name] + '</svg>'; }

  /** Full HTML document for the hosted card. vcfHref: link for "Add to contacts". */
  function renderPage(c, vcfHref) {
    var color = HEX.test(c.color || '') ? c.color : '#4f46e5';
    var fg = onColor(color);
    var name = fullName(c);
    var sub = [c.jobTitle, c.company].filter(Boolean).join(' · ');
    var quick = [];
    if (c.phones && c.phones[0]) quick.push(['tel:' + c.phones[0].number.replace(/[^\d+]/g, ''), 'phone', 'Call']);
    if (c.emails && c.emails[0]) quick.push(['mailto:' + c.emails[0], 'mail', 'Email']);
    if (c.websites && c.websites[0]) quick.push([c.websites[0], 'web', 'Website']);

    var rows = [];
    (c.phones || []).forEach(function (p) {
      rows.push(['tel:' + p.number.replace(/[^\d+]/g, ''), 'phone', p.number, (PHONE_TYPES[p.type] || PHONE_TYPES.main).label]);
    });
    (c.emails || []).forEach(function (e) { rows.push(['mailto:' + e, 'mail', e, 'Email']); });
    (c.websites || []).forEach(function (w) { rows.push([w, 'web', w.replace(/^https?:\/\//, '').replace(/\/$/, ''), 'Website']); });
    if (c.address) rows.push(['https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address), 'pin', c.address, 'Address']);
    if (c.birthday) rows.push(['', 'cake', prettyDate(c.birthday), 'Birthday']);

    var avatar = c.photo
      ? '<img class="avatar" src="' + h(c.photo) + '" alt="">'
      : '<div class="avatar ph">' + h(initials(c).toUpperCase()) + '</div>';

    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="theme-color" content="' + color + '">' +
      '<title>' + h(name) + '</title><style>' +
      '*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef0f5;color:#1c2030}' +
      '.wrap{max-width:480px;margin:0 auto;min-height:100vh;background:#fff;padding-bottom:96px}' +
      '.hero{background:' + color + ';color:' + fg + ';text-align:center;padding:36px 20px 64px}' +
      '.avatar{width:112px;height:112px;border-radius:50%;object-fit:cover;border:4px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.18);display:block;margin:0 auto 14px;background:#fff}' +
      '.ph{display:grid;place-items:center;font-size:38px;font-weight:700;color:' + color + '}' +
      'h1{margin:0;font-size:26px;line-height:1.2;overflow-wrap:anywhere}.sub{margin:6px 0 0;opacity:.85;overflow-wrap:anywhere}' +
      '.quick{display:flex;justify-content:center;gap:12px;margin:-36px 16px 8px;position:relative}' +
      '.quick a{flex:0 1 96px;display:grid;justify-items:center;gap:4px;padding:12px 6px;background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(16,24,40,.12);color:#1c2030;text-decoration:none;font-size:13px;font-weight:600}' +
      '.quick svg,.row svg{fill:' + (fg === '#ffffff' ? color : '#4b5563') + '}' +
      '.rows{padding:8px 16px}.row{display:flex;gap:14px;align-items:center;padding:14px 4px;border-bottom:1px solid #eceef3;color:inherit;text-decoration:none}' +
      '.row:last-child{border-bottom:0}.row svg{flex-shrink:0}.row b{display:block;font-weight:500;overflow-wrap:anywhere}.row span{font-size:13px;color:#6a7187}' +
      '.save{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(448px,calc(100% - 32px));display:flex;align-items:center;justify-content:center;gap:8px;padding:15px;border-radius:14px;background:' + color + ';color:' + fg + ';font-weight:700;text-decoration:none;box-shadow:0 6px 20px rgba(16,24,40,.25)}' +
      '.save svg{fill:currentColor}' +
      '</style></head><body><div class="wrap">' +
      '<header class="hero">' + avatar + '<h1>' + h(name) + '</h1>' + (sub ? '<p class="sub">' + h(sub) + '</p>' : '') + '</header>' +
      (quick.length ? '<nav class="quick">' + quick.map(function (q) {
        return '<a href="' + h(q[0]) + '"' + (q[1] === 'web' ? ' target="_blank" rel="noopener"' : '') + '>' + icon(q[1]) + h(q[2]) + '</a>';
      }).join('') + '</nav>' : '') +
      '<main class="rows">' + rows.map(function (r) {
        var inner = icon(r[1]) + '<div><b>' + h(r[2]) + '</b><span>' + h(r[3]) + '</span></div>';
        return r[0] ? '<a class="row" href="' + h(r[0]) + '"' + (r[1] === 'web' || r[1] === 'pin' ? ' target="_blank" rel="noopener"' : '') + '>' + inner + '</a>'
          : '<div class="row">' + inner + '</div>';
      }).join('') + '</main>' +
      '<a class="save" href="' + h(vcfHref) + '" download>' + icon('save') + 'Add to contacts</a>' +
      '</div></body></html>';
  }

  var api = { PHONE_TYPES: PHONE_TYPES, MAX_ITEMS: MAX_ITEMS, normalize: normalize, build: build, renderPage: renderPage, fullName: fullName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VCard = api;
})(typeof window !== 'undefined' ? window : this);
