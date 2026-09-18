(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AM4PlayerDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const key = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases = new Map(Object.entries({
    'alexander isak': 'Isak', 'alexis mac allister': 'Mac Allister', 'alexis allister': 'Mac Allister',
    'vinicius jose paixao de oliveira junior': 'Vinícius Jr.', 'vinicius junior': 'Vinícius Jr.',
    'neymar da silva santos junior': 'Neymar', 'rodrygo silva de goes': 'Rodrygo',
    'marcos aoas correa': 'Marquinhos', 'marcos correa': 'Marquinhos',
    'alisson ramses becker': 'Alisson', 'alisson becker': 'Alisson',
    'trent alexander arnold': 'Alexander-Arnold', 'ryan gravenberch': 'Gravenberch',
    'khvicha kvaratskhelia': 'Kvaratskhelia', 'warren zaire emery': 'Zaïre-Emery',
    'bukayo ayoyinka t m saka': 'Saka', 'bukayo saka': 'Saka', 'mohamed salah': 'Salah',
    'virgil van dijk': 'Van Dijk', 'kevin de bruyne': 'De Bruyne', 'frenkie de jong': 'De Jong',
    'natan bernardo de souza': 'Natan', 'rodrigo riquelme reche': 'Riquelme',
    'alvaro fernandez carreras': 'Álvaro Carreras'
  }));
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  function preferred(p) {
    const name = clean(p.name);
    const alias = aliases.get(key(name));
    if (alias) return alias;
    const supplied = [p.knownAs, p.known_as, p.commonName, p.common_name, p.shortName, p.short_name, p.displayName, p.display_name].map(clean).find(Boolean);
    if (supplied) return aliases.get(key(supplied)) || supplied;
    const parts = name.split(' ');
    // Only abbreviate an unambiguous two-part name. Unknown compound names stay intact.
    if (parts.length === 2 && !/^(van|de|del|di|da|mac|al)$/i.test(parts[0])) return parts[1];
    return name;
  }
  function createRegistry(players = []) {
    const records = new Map();
    players.filter(p => p && p.id != null).forEach(p => {
      const id = String(p.id), prior = records.get(id) || {};
      records.set(id, { ...prior, ...p, name: (prior.name || '').length > (p.name || '').length ? prior.name : p.name });
    });
    const names = new Map();
    records.forEach((p, id) => names.set(id, preferred(p)));
    const groups = new Map();
    names.forEach((name, id) => groups.set(key(name), [...(groups.get(key(name)) || []), id]));
    groups.forEach(ids => {
      if (ids.length < 2) return;
      const used = new Set();
      ids.forEach(id => {
        const p = records.get(id), base = names.get(id);
        let label = `${(p.name || '').charAt(0)}. ${base}`;
        if (used.has(label)) label = p.name || base;
        used.add(label); names.set(id, label);
      });
      // Identical initials need full names for *both* people.
      const initials = ids.map(id => `${(records.get(id).name || '').charAt(0)}. ${preferred(records.get(id))}`);
      ids.forEach((id, i) => { if (initials.filter(n => n === initials[i]).length > 1) names.set(id, records.get(id).name); });
    });
    return {
      name(p = {}) { return names.get(String(p.id)) || preferred(p); },
      full(p = {}) { return records.get(String(p.id))?.name || p.name || ''; }
    };
  }
  return { createRegistry, preferred };
});
