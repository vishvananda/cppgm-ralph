extern "C" unsigned quality_maybe_throw(unsigned);

extern "C" unsigned quality_exception(unsigned count)
{
    unsigned a = 1, b = 3, c = 5, d = 7, sum = 0;
    for (unsigned i = 0; i != count; ++i) {
        a = (a + i) * 33u;
        b ^= a + (b >> 2);
        try {
            c += quality_maybe_throw(i);
            d ^= c;
        } catch (unsigned value) {
            d += value;
            c ^= b;
        }
        sum += (a ^ b) + (c ^ d);
    }
    return sum;
}
