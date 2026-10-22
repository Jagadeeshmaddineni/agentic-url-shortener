export class MemoryStore {
  constructor() {
    this.links = new Map();
  }

  set(code, link) {
    this.links.set(code, link);
  }

  get(code) {
    return this.links.get(code);
  }
}
