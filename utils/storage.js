class Storage {
  constructor(type = 'local') {
    const isBrowser = typeof window !== 'undefined' && window[type + 'Storage'];

    if (isBrowser) {
      this.storage =
        type === 'local' ? window.localStorage : window.sessionStorage;
    } else {
      // Modo Node.js → almacenamiento en memoria
      this.storage = new Map();
    }
  }

  set(key, value) {
    const data = JSON.stringify(value);
    this.storage.setItem
      ? this.storage.setItem(key, data)
      : this.storage.set(key, data);
  }

  get(key) {
    const raw = this.storage.getItem
      ? this.storage.getItem(key)
      : this.storage.get(key);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  remove(key) {
    this.storage.removeItem
      ? this.storage.removeItem(key)
      : this.storage.delete(key);
  }

  clear() {
    this.storage.clear();
  }

  keys() {
    if (this.storage instanceof Map) {
      return Array.from(this.storage.keys());
    }
    return Object.keys(this.storage);
  }
}

const localStorage = new Storage('local');
module.exports = { localStorage };
