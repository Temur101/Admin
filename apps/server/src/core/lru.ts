/**
 * Minimal LRU cache on top of Map insertion order.
 * Used to cap the number of live grammY Bot instances in memory.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("LRU capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.entries().next();
      if (!oldest.done) {
        const [oldestKey, oldestVal] = oldest.value;
        this.map.delete(oldestKey);
        this.onEvict?.(oldestKey, oldestVal);
      }
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
