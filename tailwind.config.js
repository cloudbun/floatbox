module.exports = {
    content: ['./index.html', './src/ts/**/*.{ts,tsx}'],
    theme: {
        extend: {
            colors: {
                gray: {
                    1: 'var(--gray-1)',
                    2: 'var(--gray-2)',
                    3: 'var(--gray-3)',
                    4: 'var(--gray-4)',
                    5: 'var(--gray-5)',
                    6: 'var(--gray-6)',
                    7: 'var(--gray-7)',
                    8: 'var(--gray-8)',
                    9: 'var(--gray-9)',
                    10: 'var(--gray-10)',
                    11: 'var(--gray-11)',
                    12: 'var(--gray-12)',
                },
                risk: {
                    critical: 'var(--risk-critical)',
                    high: 'var(--risk-high)',
                    medium: 'var(--risk-medium)',
                    low: 'var(--risk-low)',
                    info: 'var(--risk-info)',
                },
            },
        },
    },
    plugins: [],
};
