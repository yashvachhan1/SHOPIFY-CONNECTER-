const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const logger = require('../utils/logger');

let productsCache = [];
let isLoaded = false;

const loadProducts = () => {
    return new Promise((resolve, reject) => {
        const results = [];
        const csvPath = path.join(__dirname, '../../products_export_1.csv');
        
        if (!fs.existsSync(csvPath)) {
            logger.warn(`CSV file not found at ${csvPath}`);
            return resolve([]);
        }

        fs.createReadStream(csvPath)
            .pipe(csv())
            .on('data', (data) => {
                // Skip variants, keep only main products or the first variant row
                if (!results.find(p => p.Handle === data.Handle)) {
                    results.push(data);
                }
            })
            .on('end', () => {
                productsCache = results;
                isLoaded = true;
                logger.info(`Loaded ${productsCache.length} products from CSV.`);
                resolve(productsCache);
            })
            .on('error', (err) => reject(err));
    });
};

const searchLocalProducts = async (query) => {
    if (!isLoaded) {
        await loadProducts();
    }
    
    if (!query || query.trim() === '') return [];
    
    const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    
    const scoredProducts = productsCache.map(product => {
        let score = 0;
        
        const title = (product.Title || '').toLowerCase();
        const body = (product['Body (HTML)'] || '').toLowerCase();
        const tags = (product.Tags || '').toLowerCase();
        const ingredients = (product['Active Ingredients (product.metafields.custom.active_ingredients)'] || '').toLowerCase();
        const shortDesc = (product['short description (product.metafields.custom.short_description)'] || '').toLowerCase();
        
        searchTerms.forEach(term => {
            if (title.includes(term)) score += 10;
            if (tags.includes(term)) score += 5;
            if (ingredients.includes(term)) score += 5;
            if (shortDesc.includes(term)) score += 3;
            if (body.includes(term)) score += 1;
        });
        
        return { product, score };
    });
    
    // Sort by score descending and take top 5
    const topMatches = scoredProducts
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(p => {
            const prod = p.product;
            // Clean up HTML tags from Body if short description is missing
            let desc = prod['short description (product.metafields.custom.short_description)'] || prod['Body (HTML)'] || '';
            desc = desc.replace(/<[^>]*>?/gm, ''); // Strip HTML
            
            return {
                handle: prod.Handle,
                title: prod.Title,
                description: desc,
                activeIngredients: prod['Active Ingredients (product.metafields.custom.active_ingredients)'],
                image: prod['Image Src']
            };
        });
        
    return topMatches;
};

module.exports = {
    loadProducts,
    searchLocalProducts
};
