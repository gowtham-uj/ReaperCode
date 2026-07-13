/**
 * Binary-heap priority queue. Lower priority number = dequeued first.
 * Ties break by insertion order (FIFO).
 */
export class PriorityQueue {
  #heap = [];
  #seq = 0;

  get size() {
    return this.#heap.length;
  }

  enqueue(item, priority) {
    if (typeof priority !== "number" || Number.isNaN(priority)) {
      throw new TypeError("priority must be a number");
    }
    this.#heap.push({ item, priority, seq: this.#seq++ });
    this.#bubbleUp(this.#heap.length - 1);
    return this.size;
  }

  peek() {
    return this.#heap.length > 0 ? this.#heap[0].item : undefined;
  }

  dequeue() {
    if (this.#heap.length === 0) return undefined;
    const top = this.#heap[0];
    const last = this.#heap.pop();
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#sinkDown(0);
    }
    return top.item;
  }

#compare(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.seq - b.seq;
  }

  #bubbleUp(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#compare(this.#heap[index], this.#heap[parent]) >= 0) break;
      [this.#heap[index], this.#heap[parent]] = [this.#heap[parent], this.#heap[index]];
      index = parent;
    }
  }

  #sinkDown(index) {
    const length = this.#heap.length;
    for (;;) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = index * 2 + 2;
      if (left < length && this.#compare(this.#heap[left], this.#heap[smallest]) < 0) smallest = left;
      if (right < length && this.#compare(this.#heap[right], this.#heap[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.#heap[index], this.#heap[smallest]] = [this.#heap[smallest], this.#heap[index]];
      index = smallest;
    }
  }
}
