let fs = require('fs');
let os = require('os');
let parse = require('csv-parse/lib/sync');

const parseTimestamp = (t) => {
    // Example: '20160407235833.627GMT'
    if (t.length != 21 || t.slice(18, 21) != 'GMT') {
        return null;
    }
    let year = parseInt(t.slice(0, 4), 10);
    let month = parseInt(t.slice(4, 6), 10) - 1;
    let date = parseInt(t.slice(6, 8), 10);
    let hours = parseInt(t.slice(8, 10), 10);
    let minutes = parseInt(t.slice(10, 12), 10);
    let seconds = parseInt(t.slice(12, 14), 10);
    let ms = parseInt(t.slice(15, 18), 10);

    return new Date(Date.UTC(year, month, date, hours, minutes, seconds, ms));
};

const parseFilename = (f) => {
    // Example: 'CHESS_FL1_C_160407_235833.627_THERM-16BIT.PNG'
    let info = {};
    let e = f.split('_');
    info.survey = e[0];
    info.flight = e[1];
    info.camPos = e[2];
    info.timestamp = parseTimestamp(`20${e[3]}${e[4]}GMT`);
    info.camType = e[5].split('-')[0];
    let e5_1 = e[5].split('-')[1];
    info.bitDepth = e5_1 == '16BIT' ? 16 : (e5_1 == '8' ? 8 : 0);
    return info; 
};

const parseFilters = (filters) => {
    if (!filters)
        return [];
    return filters.split(',').map((filter) => {
        let split = filter.split('=');
        let field = split[0];
        let value = split[1];
        return (record) => {
            return record[field] === value; 
        };
    });
};

const initImageFileStats = () => {
    return {
        uniqueImages: new Map(), // Image name to image info 
        timestampVariations: 0,
        sumTimestampVariationMs: 0,
        maxTimestampVariationMs: 0
    };
};

const initRecordStats = () => {
    return {
        uniqueHotspots: new Map(), // Hotspot id to { hotspot_type, species_id }
        totalHotspots: 0,

        uniqueTimestamps: new Set(),

        thermal16Stats: initImageFileStats(),
        thermal8Stats: initImageFileStats(),
        colorStats: initImageFileStats(),

        hotspotTypes: new Map(),
        speciesTypes: new Map(),

        errors: 0
    };
};

const updateTimestampVariation = (t1, t2, currMax) => {
    return variation > currMax ? variation : currMax;
};

const updateImageFileStats = (timestamp, f, imageStats) => {
    let info = parseFilename(f);
    if (!info.timestamp) {
        return false;
    }
    if (!imageStats.uniqueImages.has(f)) {
        imageStats.uniqueImages.set(f, { bboxes: [] });
    }
    if (info.timestamp.valueOf() != timestamp.valueOf()) {
        imageStats.timestampVariations++;
        let variation = Math.abs(info.timestamp.valueOf() - timestamp.valueOf());
        imageStats.sumTimestampVariationMs += variation;
        if (variation > imageStats.maxTimestampVariationMs) {
            imageStats.maxTimestampVariationMs = variation;
        }
    }
    return true;
};

const examineRecord = (r, stats) => {
    stats.uniqueHotspots.set(r.hotspot_id, {
        hotspot_type: r.hotspot_type,
        species_id: r.species_id
    });
    stats.totalHotspots++;

    let timestamp = parseTimestamp(r.timestamp);
    if (!timestamp) {
        stats.errors++;
        return;
    }
    stats.uniqueTimestamps.add(timestamp.valueOf());
    if (!updateImageFileStats(timestamp, r.filt_thermal16, stats.thermal16Stats)) {
        stats.errors++;
        return;
    }
    if (!updateImageFileStats(timestamp, r.filt_thermal8, stats.thermal8Stats)) {
        stats.errors++;
        return;
    }
    if (!updateImageFileStats(timestamp, r.filt_color, stats.colorStats)) {
        stats.errors++;
        return;
    }
    const margin = 10; // Thermal bounding box margin
    stats.thermal16Stats.uniqueImages.get(r.filt_thermal16).bboxes.push({
        label: r.hotspot_type,
        left: parseInt(r.x_pos) - margin,
        top: parseInt(r.y_pos) - margin,
        right: parseInt(r.x_pos) + margin,
        bottom: parseInt(r.y_pos) + margin
    });
    stats.colorStats.uniqueImages.get(r.filt_color).bboxes.push({
        label: `${r.hotspot_type} (${r.species_id})`,
        left: parseInt(r.thumb_left),
        top: parseInt(r.thumb_top),
        right: parseInt(r.thumb_right),
        bottom: parseInt(r.thumb_bottom),
    });
    if (stats.hotspotTypes.has(r.hotspot_type)) {
        stats.hotspotTypes.set(r.hotspot_type, stats.hotspotTypes.get(r.hotspot_type) + 1);
    } else {
        stats.hotspotTypes.set(r.hotspot_type, 1);
    }
    if (stats.speciesTypes.has(r.species_id)) {
        stats.speciesTypes.set(r.species_id, stats.speciesTypes.get(r.species_id) + 1);
    } else {
        stats.speciesTypes.set(r.species_id, 1);
    }
};

const printImageFileStats = (imageStats) => {
    console.log(`  Unique images: ${imageStats.uniqueImages.size}`);
    console.log(`  Timestamp variations: ${imageStats.timestampVariations}`);
    console.log(`  Avg timestamp variation (ms): ${imageStats.timestampVariations > 0 ? imageStats.sumTimestampVariationMs/imageStats.timestampVariations: 0}`);
    console.log(`  Max timestamp variation (ms): ${imageStats.maxTimestampVariationMs}`);
};

const printStats = (stats) => {
    console.log(`Total hotspots: ${stats.totalHotspots}`);
    console.log(`Unique hotspots: ${stats.uniqueHotspots.size}`);
    console.log(`Unique timestamps: ${stats.uniqueTimestamps.size}`);
    console.log('Thermal16 stats:');
    printImageFileStats(stats.thermal16Stats);
    console.log('Thermal8 stats:');
    printImageFileStats(stats.thermal8Stats);
    console.log('Color stats:');
    printImageFileStats(stats.colorStats);
    console.log(`Hot spot types:`);
    for (let hotspotType of stats.hotspotTypes.keys()) {
        console.log(`  ${hotspotType}: ${stats.hotspotTypes.get(hotspotType)}`);
    } 
    console.log(`Species types:`);
    for (let speciesType of stats.speciesTypes.keys()) {
        console.log(`  ${speciesType}: ${stats.speciesTypes.get(speciesType)}`);
    }
};

const getCsvRecords = (filename, filters) => {
    let input = fs.readFileSync(filename).toString();
    let records = parse(input, {columns: true});
    return records.filter((record) => {
        return !filters || filters.every((filter) => filter(record));
    });
};

const getCsvStats = (records) => {
    let stats = initRecordStats();
    for (let r of records) {
        examineRecord(r, stats);
    }
    return stats;
};

const writeCsvHeader = (writer) => {
    writer.write(`"hotspot_id","timestamp","filt_thermal16","filt_thermal8","filt_color","x_pos","y_pos","thumb_left","thumb_top","thumb_right","thumb_bottom","hotspot_type","species_id"${os.EOL}`);
};

const writeCsvRecord = (writer, r) => {
    writer.write(`"${r.hotspot_id}","${r.timestamp}","${r.filt_thermal16}","${r.filt_thermal8}","${r.filt_color}",${r.x_pos},${r.y_pos},${r.thumb_left},${r.thumb_top},${r.thumb_right},${r.thumb_bottom},"${r.hotspot_type}","${r.species_id}"${os.EOL}`);
};

module.exports.parseFilters = parseFilters;
module.exports.getCsvRecords = getCsvRecords;
module.exports.getCsvStats = getCsvStats;
module.exports.writeCsvHeader = writeCsvHeader;
module.exports.writeCsvRecord = writeCsvRecord;
module.exports.printStats = printStats;