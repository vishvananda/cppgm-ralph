// Ordinary C++11; compile with QUALITY_DORMANT=0, 1 or 2.
#ifndef QUALITY_DORMANT
#define QUALITY_DORMANT 0
#endif

#define QUALITY_FUNCTION(B, N) \
inline unsigned quality_unused_##B##_##N(unsigned x) { \
    for (unsigned i = 0; i != 16; ++i) \
        x = (x ^ (x >> 3)) * 1664525u + (B * 16u + N) + i; \
    return x; \
}
#define QUALITY_GROUP(B) \
QUALITY_FUNCTION(B, 0) QUALITY_FUNCTION(B, 1) \
QUALITY_FUNCTION(B, 2) QUALITY_FUNCTION(B, 3) \
QUALITY_FUNCTION(B, 4) QUALITY_FUNCTION(B, 5) \
QUALITY_FUNCTION(B, 6) QUALITY_FUNCTION(B, 7) \
QUALITY_FUNCTION(B, 8) QUALITY_FUNCTION(B, 9) \
QUALITY_FUNCTION(B, 10) QUALITY_FUNCTION(B, 11) \
QUALITY_FUNCTION(B, 12) QUALITY_FUNCTION(B, 13) \
QUALITY_FUNCTION(B, 14) QUALITY_FUNCTION(B, 15)

#if QUALITY_DORMANT >= 1
QUALITY_GROUP(0) QUALITY_GROUP(1) QUALITY_GROUP(2) QUALITY_GROUP(3)
#endif
#if QUALITY_DORMANT >= 2
QUALITY_GROUP(4) QUALITY_GROUP(5) QUALITY_GROUP(6) QUALITY_GROUP(7)
QUALITY_GROUP(8) QUALITY_GROUP(9) QUALITY_GROUP(10) QUALITY_GROUP(11)
QUALITY_GROUP(12) QUALITY_GROUP(13) QUALITY_GROUP(14) QUALITY_GROUP(15)
#endif

// These externally usable definitions MUST survive even though this TU
// contains no calls to them. The separate consumer supplies those calls.
extern "C" unsigned quality_export(unsigned x)
{
    return (x ^ (x >> 7)) * 33u + 7u;
}

template<class T> T quality_special(T);
template<> unsigned quality_special<unsigned>(unsigned x)
{
    return x + 19u;
}
