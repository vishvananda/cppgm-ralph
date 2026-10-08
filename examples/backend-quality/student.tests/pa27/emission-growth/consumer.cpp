extern "C" unsigned quality_export(unsigned);
template<class T> T quality_special(T);
template<> unsigned quality_special<unsigned>(unsigned);

int main()
{
    unsigned x = 0;
    for (unsigned i = 0; i != 257; ++i) {
        if (quality_export(x) != (x ^ (x >> 7)) * 33u + 7u)
            return 1;
        if (quality_special<unsigned>(x) != x + 19u)
            return 2;
        x = x * 1664525u + 1013904223u;
    }
    return 0;
}
