// Data structure workloads on a bump allocator: quicksort, heap sort, a hash
// table with chaining, linked list reversal and merge sort, a binary tree.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

static uint8_t heap[512 * 1024];
static size_t heap_used;

static NOINLINE void *bump(size_t n)
{
    size_t at = (heap_used + 15) & ~(size_t)15;
    if (at + n > sizeof heap) {
        puts("out of memory");
        exit(99);
    }
    heap_used = at + n;
    return heap + at;
}

// ---- sorting ----------------------------------------------------------------

static void swap64(int64_t *a, int64_t *b) { int64_t t = *a; *a = *b; *b = t; }

static NOINLINE void quicksort(int64_t *v, int lo, int hi)
{
    while (lo < hi) {
        if (hi - lo < 8) {          // insertion sort for short ranges
            for (int i = lo + 1; i <= hi; i++) {
                int64_t x = v[i];
                int j = i - 1;
                while (j >= lo && v[j] > x) {
                    v[j + 1] = v[j];
                    j--;
                }
                v[j + 1] = x;
            }
            return;
        }
        int mid = lo + (hi - lo) / 2;
        if (v[mid] < v[lo]) swap64(&v[mid], &v[lo]);
        if (v[hi] < v[lo]) swap64(&v[hi], &v[lo]);
        if (v[hi] < v[mid]) swap64(&v[hi], &v[mid]);
        int64_t pivot = v[mid];
        int i = lo, j = hi;
        while (i <= j) {
            while (v[i] < pivot) i++;
            while (v[j] > pivot) j--;
            if (i <= j) {
                swap64(&v[i], &v[j]);
                i++;
                j--;
            }
        }
        if (j - lo < hi - i) {      // recurse into the smaller half
            quicksort(v, lo, j);
            lo = i;
        } else {
            quicksort(v, i, hi);
            hi = j;
        }
    }
}

// Generic sort through a comparison callback (indirect calls in the inner loop).
typedef int (*cmp_fn)(const void *, const void *);
static NOINLINE void heapsort_generic(void *base, size_t n, size_t size, cmp_fn cmp)
{
    uint8_t *b = base;
    uint8_t tmp[32];
#define EL(i) (b + (i) * size)
#define SWAP(i, j) do { memcpy(tmp, EL(i), size); memcpy(EL(i), EL(j), size); memcpy(EL(j), tmp, size); } while (0)
    for (size_t start = n / 2; start-- > 0;) {
        size_t root = start;
        for (;;) {
            size_t child = root * 2 + 1;
            if (child >= n) break;
            if (child + 1 < n && cmp(EL(child), EL(child + 1)) < 0) child++;
            if (cmp(EL(root), EL(child)) >= 0) break;
            SWAP(root, child);
            root = child;
        }
    }
    for (size_t end = n; end-- > 1;) {
        SWAP(0, end);
        size_t root = 0;
        for (;;) {
            size_t child = root * 2 + 1;
            if (child >= end) break;
            if (child + 1 < end && cmp(EL(child), EL(child + 1)) < 0) child++;
            if (cmp(EL(root), EL(child)) >= 0) break;
            SWAP(root, child);
            root = child;
        }
    }
#undef EL
#undef SWAP
}

struct rec { uint32_t key; int16_t minor; char tag[6]; };
static int cmp_rec(const void *a, const void *b)
{
    const struct rec *x = a, *y = b;
    if (x->key != y->key) return x->key < y->key ? -1 : 1;
    return (int)x->minor - (int)y->minor;
}
static int cmp_u16_desc(const void *a, const void *b) { return (int)*(const uint16_t *)b - (int)*(const uint16_t *)a; }

// ---- hash table -------------------------------------------------------------

struct entry { struct entry *next; uint64_t key; uint32_t value; uint32_t hits; };
struct table { struct entry **buckets; uint32_t nbuckets, count; };

static uint64_t hash_key(uint64_t k)
{
    k ^= k >> 33; k *= 0xff51afd7ed558ccdull; k ^= k >> 33; k *= 0xc4ceb9fe1a85ec53ull; k ^= k >> 33;
    return k;
}

static NOINLINE struct table *table_new(uint32_t nbuckets)
{
    struct table *t = bump(sizeof *t);
    t->buckets = bump(nbuckets * sizeof *t->buckets);
    memset(t->buckets, 0, nbuckets * sizeof *t->buckets);
    t->nbuckets = nbuckets;
    t->count = 0;
    return t;
}

static NOINLINE struct entry *table_find(struct table *t, uint64_t key, int insert)
{
    struct entry **slot = &t->buckets[hash_key(key) % t->nbuckets];
    for (struct entry *e = *slot; e; e = e->next)
        if (e->key == key) {
            e->hits++;
            return e;
        }
    if (!insert) return 0;
    struct entry *e = bump(sizeof *e);
    e->key = key; e->value = 0; e->hits = 0;
    e->next = *slot;
    *slot = e;
    t->count++;
    return e;
}

static NOINLINE int table_remove(struct table *t, uint64_t key)
{
    struct entry **pp = &t->buckets[hash_key(key) % t->nbuckets];
    for (; *pp; pp = &(*pp)->next)
        if ((*pp)->key == key) {
            *pp = (*pp)->next;
            t->count--;
            return 1;
        }
    return 0;
}

// ---- linked list --------------------------------------------------------------

struct node { struct node *next; int32_t val; };

static NOINLINE struct node *list_reverse(struct node *h)
{
    struct node *prev = 0;
    while (h) {
        struct node *n = h->next;
        h->next = prev;
        prev = h;
        h = n;
    }
    return prev;
}

static NOINLINE struct node *list_merge_sort(struct node *h)
{
    if (!h || !h->next) return h;
    struct node *slow = h, *fast = h->next;
    while (fast && fast->next) {
        slow = slow->next;
        fast = fast->next->next;
    }
    struct node *b = slow->next;
    slow->next = 0;
    struct node *a = list_merge_sort(h);
    b = list_merge_sort(b);
    struct node head, *tail = &head;
    while (a && b) {
        if (a->val <= b->val) { tail->next = a; a = a->next; }
        else { tail->next = b; b = b->next; }
        tail = tail->next;
    }
    tail->next = a ? a : b;
    return head.next;
}

// ---- binary search tree ---------------------------------------------------------

struct tree { struct tree *l, *r; uint32_t key; uint32_t count; };

static NOINLINE struct tree *tree_insert(struct tree *t, uint32_t key)
{
    if (!t) {
        t = bump(sizeof *t);
        t->l = t->r = 0; t->key = key; t->count = 1;
        return t;
    }
    if (key < t->key) t->l = tree_insert(t->l, key);
    else if (key > t->key) t->r = tree_insert(t->r, key);
    else t->count++;
    return t;
}

static NOINLINE void tree_walk(const struct tree *t, int depth, uint64_t *h, int *maxdepth, int *nodes)
{
    if (!t) return;
    tree_walk(t->l, depth + 1, h, maxdepth, nodes);
    *h = mix64(*h, (uint64_t)t->key << 8 | t->count);
    if (depth > *maxdepth) *maxdepth = depth;
    ++*nodes;
    tree_walk(t->r, depth + 1, h, maxdepth, nodes);
}

int main(void)
{
    uint64_t seed = 0xfeedfacecafef00dull;

    puts("== quicksort ==");
    {
        enum { N = 3000 };
        int64_t *v = bump(N * sizeof *v);
        for (int pass = 0; pass < 3; pass++) {
            for (int i = 0; i < N; i++) {
                uint64_t r = rng_next(&seed);
                v[i] = pass == 0 ? (int64_t)r : pass == 1 ? (int64_t)(r % 50) - 25 : (int64_t)(N - i);
            }
            quicksort(v, 0, N - 1);
            int sorted = 1;
            uint64_t h = 0;
            for (int i = 0; i < N; i++) {
                if (i && v[i - 1] > v[i]) sorted = 0;
                h = mix64(h, (uint64_t)v[i]);
            }
            printf("pass %d sorted=%d hash=%016lx first=%ld mid=%ld last=%ld\n", pass, sorted, h, v[0],
                   v[N / 2], v[N - 1]);
        }
    }

    puts("== heapsort with callbacks ==");
    {
        enum { N = 700 };
        struct rec *r = bump(N * sizeof *r);
        for (int i = 0; i < N; i++) {
            uint64_t x = rng_next(&seed);
            r[i].key = (uint32_t)(x % 97);
            r[i].minor = (int16_t)(x >> 20);
            for (int k = 0; k < 5; k++) r[i].tag[k] = (char)('a' + (x >> (30 + k * 5)) % 26);
            r[i].tag[5] = 0;
        }
        heapsort_generic(r, N, sizeof *r, cmp_rec);
        uint64_t h = 0;
        int sorted = 1;
        for (int i = 0; i < N; i++) {
            if (i && cmp_rec(&r[i - 1], &r[i]) > 0) sorted = 0;
            h = mix64(h, (uint64_t)r[i].key << 16 ^ (uint16_t)r[i].minor ^ (uint64_t)r[i].tag[2] << 40);
        }
        printf("records sorted=%d hash=%016lx  [0]=%u/%d/%s [699]=%u/%d/%s\n", sorted, h, r[0].key, r[0].minor,
               r[0].tag, r[N - 1].key, r[N - 1].minor, r[N - 1].tag);
        uint16_t *w = bump(500 * sizeof *w);
        for (int i = 0; i < 500; i++) w[i] = (uint16_t)rng_next(&seed);
        heapsort_generic(w, 500, sizeof *w, cmp_u16_desc);
        h = 0;
        for (int i = 0; i < 500; i++) h = mix64(h, w[i]);
        printf("u16 desc hash=%016lx first=%u last=%u\n", h, w[0], w[499]);
    }

    puts("== hash table ==");
    {
        struct table *t = table_new(257);
        uint64_t s2 = 99;
        for (int i = 0; i < 6000; i++) {
            uint64_t key = rng_next(&s2) % 1500;
            struct entry *e = table_find(t, key * 0x10001, 1);
            e->value += (uint32_t)i;
        }
        printf("count=%u\n", t->count);
        int removed = 0, found = 0;
        for (uint64_t k = 0; k < 1500; k += 3) removed += table_remove(t, k * 0x10001);
        for (uint64_t k = 0; k < 1500; k++) found += table_find(t, k * 0x10001, 0) != 0;
        uint64_t h = 0;
        uint32_t longest = 0;
        for (uint32_t b = 0; b < t->nbuckets; b++) {
            uint32_t len = 0;
            for (struct entry *e = t->buckets[b]; e; e = e->next) {
                h += hash_key(e->key ^ ((uint64_t)e->value << 20) ^ ((uint64_t)e->hits << 50));
                len++;
            }
            if (len > longest) longest = len;
        }
        printf("removed=%d found=%d count=%u longest=%u hash=%016lx\n", removed, found, t->count, longest, h);
    }

    puts("== linked list ==");
    {
        struct node *head = 0;
        for (int i = 0; i < 2500; i++) {
            struct node *n = bump(sizeof *n);
            n->val = (int32_t)(rng_next(&seed) >> 40) - (1 << 23);
            n->next = head;
            head = n;
        }
        uint64_t h = 0;
        for (struct node *n = head; n; n = n->next) h = mix64(h, (uint64_t)(int64_t)n->val);
        printf("unsorted hash=%016lx\n", h);
        head = list_reverse(head);
        h = 0;
        for (struct node *n = head; n; n = n->next) h = mix64(h, (uint64_t)(int64_t)n->val);
        printf("reversed hash=%016lx\n", h);
        head = list_merge_sort(head);
        h = 0;
        int sorted = 1, len = 0;
        for (struct node *n = head; n; n = n->next) {
            if (n->next && n->val > n->next->val) sorted = 0;
            h = mix64(h, (uint64_t)(int64_t)n->val);
            len++;
        }
        printf("sorted=%d len=%d hash=%016lx min=%d\n", sorted, len, h, head->val);
    }

    puts("== binary tree ==");
    {
        struct tree *root = 0;
        for (int i = 0; i < 4000; i++) root = tree_insert(root, (uint32_t)(rng_next(&seed) % 3001));
        uint64_t h = 0;
        int maxdepth = 0, nodes = 0;
        tree_walk(root, 0, &h, &maxdepth, &nodes);
        printf("nodes=%d depth=%d hash=%016lx\n", nodes, maxdepth, h);
    }
    printf("heap used=%lu\n", heap_used);
    return 0;
}
