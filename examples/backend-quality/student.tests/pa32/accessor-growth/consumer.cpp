extern "C" unsigned quality_loop(unsigned *, unsigned *, unsigned);
static unsigned observed_calls;

extern "C" unsigned quality_observe(unsigned *p)
{
    ++observed_calls;
    *p = *p * 1664525u + 1013904223u;
    return *p ^ observed_calls;
}

// Independent scalar oracle, with explicit sequencing around aliasing/calls.
static unsigned expected(unsigned *a, unsigned *b, unsigned count)
{
    unsigned sum = 0;
    for (unsigned i = 0; i != count; ++i) {
        unsigned before = *a;
        *b = before + (i ^ 17u);
        if ((i & 7u) == 3u) {
            ++observed_calls;
            *a = *a * 1664525u + 1013904223u;
            sum ^= *a ^ observed_calls;
        }
        sum += *a ^ before;
    }
    return sum;
}

int main()
{
    const unsigned counts[] = {0, 1, 3, 4, 8, 17, 257};
    const unsigned seeds[] = {0, 1, 0xffffffffu, 0x80000000u, 123456789u};
    for (unsigned alias = 0; alias != 2; ++alias)
        for (unsigned c = 0; c != 7; ++c)
            for (unsigned s = 0; s != 5; ++s) {
                unsigned a = seeds[s], b = ~seeds[s];
                unsigned want_a = a, want_b = b;
                observed_calls = 0;
                unsigned want = expected(&want_a, alias ? &want_a : &want_b, counts[c]);
                unsigned want_calls = observed_calls;
                observed_calls = 0;
                unsigned got = quality_loop(&a, alias ? &a : &b, counts[c]);
                if (got != want || a != want_a || b != want_b || observed_calls != want_calls)
                    return 1;
            }
    return 0;
}
