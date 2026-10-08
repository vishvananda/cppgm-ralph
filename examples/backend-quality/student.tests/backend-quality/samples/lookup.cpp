#include "lookup.h"

static unsigned find(const QualitySlot *slots, unsigned mask, unsigned long long key)
{
    unsigned p = quality_hash(key) & mask;
    while (slots[p].value) {
        if (slots[p].key() == key) return slots[p].value;
        p = (p + 1) & mask;
    }
    return 0;
}

extern "C" unsigned quality_lookup(const QualitySlot *slots, unsigned mask, unsigned count)
{
    unsigned sum = 0;
    for (unsigned n = 0; n != count; ++n) {
        unsigned i = n & 1023u;
        unsigned low = (i & 15u) == 15u ? i + 1024u : i;
        sum += find(slots, mask, (static_cast<unsigned long long>(i) << 32) | low);
    }
    return sum;
}
