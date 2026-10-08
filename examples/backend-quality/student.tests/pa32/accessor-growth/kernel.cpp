// Ordinary C++11; compare QUALITY_DEPTH=0, 8 and 64 at O2/O3.
#ifndef QUALITY_DEPTH
#define QUALITY_DEPTH 0
#endif

template<unsigned Depth> struct QualityView {
    static unsigned load(unsigned *p) { return QualityView<Depth - 1>::load(p); }
    static void store(unsigned *p, unsigned x) { QualityView<Depth - 1>::store(p, x); }
};
template<> struct QualityView<0> {
    static unsigned load(unsigned *p) { return *p; }
    static void store(unsigned *p, unsigned x) { *p = x; }
};

// Its body is in another TU, so the compiler must respect its memory effects.
extern "C" unsigned quality_observe(unsigned *);

extern "C" unsigned quality_loop(unsigned *a, unsigned *b, unsigned count)
{
    unsigned sum = 0;
    for (unsigned i = 0; i != count; ++i) {
        unsigned before = QualityView<QUALITY_DEPTH>::load(a);
        QualityView<QUALITY_DEPTH>::store(b, before + (i ^ 17u));
        if ((i & 7u) == 3u)
            sum ^= quality_observe(a);
        sum += QualityView<QUALITY_DEPTH>::load(a) ^ before;
    }
    return sum;
}
