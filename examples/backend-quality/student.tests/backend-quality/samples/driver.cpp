// Always built once per case with GCC, then linked unchanged to each kernel.
#include <cstdio>
#include <cstdlib>
#include "lookup.h"

extern "C" unsigned quality_loop(unsigned *, unsigned *, unsigned);
extern "C" unsigned quality_lookup(const QualitySlot *, unsigned, unsigned);
extern "C" unsigned quality_exception(unsigned);
static unsigned observed_calls;

extern "C" unsigned quality_observe(unsigned *p)
{
    ++observed_calls;
    *p = *p * 1664525u + 1013904223u;
    return *p ^ observed_calls;
}
extern "C" unsigned quality_maybe_throw(unsigned i)
{
    if ((i & 0xfffffu) == 17u) throw i;
    return i * 33u + 7u;
}

static unsigned scalar_loop(unsigned *a, unsigned *b, unsigned count)
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
static unsigned scalar_exception(unsigned count)
{
    unsigned a = 1, b = 3, c = 5, d = 7, sum = 0;
    for (unsigned i = 0; i != count; ++i) {
        a = (a + i) * 33u;
        b ^= a + (b >> 2);
        if ((i & 0xfffffu) == 17u) { d += i; c ^= b; }
        else { c += i * 33u + 7u; d ^= c; }
        sum += (a ^ b) + (c ^ d);
    }
    return sum;
}

int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    bool oracle = argv[1][0] == 'o';
    unsigned count = std::strtoul(argv[2], 0, 10);
    unsigned alias = std::strtoul(argv[3], 0, 10);
    unsigned a = 0x12345678u, b = ~a, result = 0;
#if QUALITY_CASE == 1
    result = oracle ? scalar_loop(&a, alias ? &a : &b, count)
                    : quality_loop(&a, alias ? &a : &b, count);
#elif QUALITY_CASE == 2
    QualitySlot slots[2048] = {};
    for (unsigned i = 0; i != 1024; ++i) {
        unsigned long long key = (static_cast<unsigned long long>(i) << 32) | i;
        unsigned p = quality_hash(key) & 2047u;
        while (slots[p].value) p = (p + 1) & 2047u;
        slots[p].low = i; slots[p].high = i; slots[p].value = i + 1;
    }
    unsigned tail = count & 1023u, missing = tail / 16u;
    result = oracle ? (count / 1024u) * 491520u + tail * (tail + 1u) / 2u - 8u * missing * (missing + 1u)
                    : quality_lookup(slots, 2047u, count);
#elif QUALITY_CASE == 3
    result = oracle ? scalar_exception(count) : quality_exception(count);
#else
#error Invalid QUALITY_CASE
#endif
    std::printf("%u:%u:%u:%u\n", result, a, b, observed_calls);
    return 0;
}
