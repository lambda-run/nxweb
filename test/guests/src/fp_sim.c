// Floating point simulations whose final state depends on every operation
// along the way: an n-body integrator (double), a Mandelbrot set (float and
// double) and a small dense matrix kernel. Checksums are over the raw bits.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

struct body { double x, y, z, vx, vy, vz, mass; };

static struct body bodies[5] = {
    {0, 0, 0, 0, 0, 0, 39.47841760435743},
    {4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
     6.06326392995832e-01, 2.81198684491626e+00, -2.52183616598876e-02, 3.769367487038949e-02},
    {8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
     -1.01077434617879e+00, 1.82566237123041e+00, 8.41576137658415e-03, 1.128632613196877e-02},
    {1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
     1.08279100644153e+00, 8.68713018169608e-01, -1.08326374013636e-02, 1.723724057059711e-03},
    {1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
     9.79090732243898e-01, 5.94698998647676e-01, -3.47559555040781e-02, 2.033686869924631e-03},
};

static NOINLINE double energy(void)
{
    double e = 0;
    for (int i = 0; i < 5; i++) {
        struct body *b = &bodies[i];
        e += 0.5 * b->mass * (b->vx * b->vx + b->vy * b->vy + b->vz * b->vz);
        for (int j = i + 1; j < 5; j++) {
            double dx = b->x - bodies[j].x, dy = b->y - bodies[j].y, dz = b->z - bodies[j].z;
            e -= b->mass * bodies[j].mass / __builtin_sqrt(dx * dx + dy * dy + dz * dz);
        }
    }
    return e;
}

static NOINLINE void advance(double dt)
{
    for (int i = 0; i < 5; i++) {
        struct body *a = &bodies[i];
        for (int j = i + 1; j < 5; j++) {
            struct body *b = &bodies[j];
            double dx = a->x - b->x, dy = a->y - b->y, dz = a->z - b->z;
            double d2 = dx * dx + dy * dy + dz * dz;
            double mag = dt / (d2 * __builtin_sqrt(d2));
            a->vx -= dx * b->mass * mag; a->vy -= dy * b->mass * mag; a->vz -= dz * b->mass * mag;
            b->vx += dx * a->mass * mag; b->vy += dy * a->mass * mag; b->vz += dz * a->mass * mag;
        }
    }
    for (int i = 0; i < 5; i++) {
        struct body *b = &bodies[i];
        b->x += dt * b->vx; b->y += dt * b->vy; b->z += dt * b->vz;
    }
}

static uint64_t bodies_hash(void)
{
    uint64_t h = 0;
    for (int i = 0; i < 5; i++) {
        const double *p = &bodies[i].x;
        for (int k = 0; k < 6; k++) h = mix64(h, f64_bits(p[k]));
    }
    return h;
}

static NOINLINE int mandel_d(double cr, double ci, int limit)
{
    double zr = 0, zi = 0;
    int n = 0;
    while (n < limit && zr * zr + zi * zi <= 4.0) {
        double t = zr * zr - zi * zi + cr;
        zi = 2.0 * zr * zi + ci;
        zr = t;
        n++;
    }
    return n;
}

static NOINLINE int mandel_f(float cr, float ci, int limit)
{
    float zr = 0, zi = 0;
    int n = 0;
    while (n < limit && zr * zr + zi * zi <= 4.0f) {
        float t = zr * zr - zi * zi + cr;
        zi = 2.0f * zr * zi + ci;
        zr = t;
        n++;
    }
    return n;
}

#define MN 12
static double ma[MN][MN], mb[MN][MN], mc[MN][MN];

static NOINLINE void matmul(void)
{
    for (int i = 0; i < MN; i++)
        for (int j = 0; j < MN; j++) {
            double s = 0;
            for (int k = 0; k < MN; k++) s += ma[i][k] * mb[k][j];
            mc[i][j] = s;
        }
}

// Gaussian elimination with partial pivoting; returns the determinant.
static NOINLINE double determinant(double m[MN][MN])
{
    double det = 1;
    for (int c = 0; c < MN; c++) {
        int p = c;
        for (int r = c + 1; r < MN; r++)
            if (__builtin_fabs(m[r][c]) > __builtin_fabs(m[p][c])) p = r;
        if (m[p][c] == 0.0) return 0;
        if (p != c) {
            for (int k = 0; k < MN; k++) {
                double t = m[p][k];
                m[p][k] = m[c][k];
                m[c][k] = t;
            }
            det = -det;
        }
        det *= m[c][c];
        for (int r = c + 1; r < MN; r++) {
            double f = m[r][c] / m[c][c];
            for (int k = c; k < MN; k++) m[r][k] -= f * m[c][k];
        }
    }
    return det;
}

int main(void)
{
    puts("== n-body ==");
    {
        double px = 0, py = 0, pz = 0;
        for (int i = 0; i < 5; i++) {
            px += bodies[i].vx * bodies[i].mass; py += bodies[i].vy * bodies[i].mass; pz += bodies[i].vz * bodies[i].mass;
        }
        bodies[0].vx = -px / bodies[0].mass; bodies[0].vy = -py / bodies[0].mass; bodies[0].vz = -pz / bodies[0].mass;
        printf("energy before %.9f %016lx\n", energy(), f64_bits(energy()));
        for (int step = 1; step <= 1000; step++) {
            advance(0.01);
            if (step % 250 == 0) printf("step %4d hash %016lx x1=%.9f\n", step, bodies_hash(), bodies[1].x);
        }
        printf("energy after  %.9f %016lx\n", energy(), f64_bits(energy()));
    }

    puts("== mandelbrot (double) ==");
    {
        uint64_t h = 0;
        long total = 0;
        for (int y = 0; y < 22; y++) {
            char line[64];
            for (int x = 0; x < 60; x++) {
                int n = mandel_d(-2.2 + x * 0.05, -1.1 + y * 0.1, 80);
                total += n;
                h = mix64(h, (uint64_t)n);
                line[x] = n >= 80 ? '#' : " .:-=+*%@"[n % 9];
            }
            line[60] = 0;
            puts(line);
        }
        printf("iterations %ld hash %016lx\n", total, h);
    }
    puts("== mandelbrot (float) ==");
    {
        uint64_t h = 0;
        long total = 0;
        for (int y = 0; y < 40; y++)
            for (int x = 0; x < 60; x++) {
                int n = mandel_f(-2.2f + (float)x * 0.05f, -1.1f + (float)y * 0.055f, 60);
                total += n;
                h = mix64(h, (uint64_t)n);
            }
        printf("iterations %ld hash %016lx\n", total, h);
    }

    puts("== matrices ==");
    {
        uint64_t seed = 77;
        for (int i = 0; i < MN; i++)
            for (int j = 0; j < MN; j++) {
                ma[i][j] = (double)(int64_t)(rng_next(&seed) % 2001 - 1000) / 250.0;
                mb[i][j] = (double)(int64_t)(rng_next(&seed) % 2001 - 1000) / 500.0 + (i == j ? 2.0 : 0.0);
            }
        uint64_t h = 0;
        for (int round = 0; round < 4; round++) {
            matmul();
            double norm = 0;
            for (int i = 0; i < MN; i++)
                for (int j = 0; j < MN; j++) {
                    h = mix64(h, f64_bits(mc[i][j]));
                    norm += mc[i][j] * mc[i][j];
                }
            norm = __builtin_sqrt(norm);
            for (int i = 0; i < MN; i++)
                for (int j = 0; j < MN; j++) ma[i][j] = mc[i][j] / norm;
            printf("round %d norm %.9f hash %016lx\n", round, norm, h);
        }
        double d1 = determinant(mb);
        double d2 = determinant(ma);
        printf("det(b)=%.6f %016lx det(a)=%016lx\n", d1, f64_bits(d1), f64_bits(d2));
    }
    return 0;
}
