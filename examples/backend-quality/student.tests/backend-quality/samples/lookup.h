struct QualitySlot {
    unsigned low, high, value;
    unsigned long long key() const {
        return (static_cast<unsigned long long>(high) << 32) | low;
    }
};
inline unsigned long long quality_hash(unsigned long long x) {
    x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27; x *= 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}
