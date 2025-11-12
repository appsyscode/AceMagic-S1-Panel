'use strict';
/*!
 * s1panel - sensor/memory
 * Copyright (c) 2024-2025 Tomasz Jaworski
 * GPL-3 Licensed
 */
const fs = require('fs');

const logger = require('../logger');

var _fault = false;

var _max_points = 10;
var _last_sampled = 0;

var _free_history = [];
var _cache_history = [];
var _active_history = [];
var _usage_history = [];
var _used_swap_history = [];
var _swap_history = [];

var _total_memory = 0;
var _swap_total = 0;

var _previous = null;

function read_file(path) {
  
    return new Promise((fulfill, reject) => {

        fs.readFile(path, 'utf8', (err, data) => {
            
            if (err) {
                return reject(err);
            }

            fulfill(data);
        });
    });
}

function record_sample(array, value, max_points) {

    if (!array.length) {

        for (var i = 0; i < max_points; i++) {
            array.push(0);
        }
    }

    array.push(value);
    array.shift();

    return value;
}

function calc_memory_usage(current) {

    var _current_total = 0;
    var _current_free = 0;
    var _current_cached = 0;
    var _current_swap_total = 0;
    var _current_swap_free = 0;

    current.forEach(each => {

        const _match_total = each.match(/^MemTotal:\s+(\d+)/);
        const _match_free = each.match(/^MemFree:\s+(\d+)/);
        const _match_cached = each.match(/^Cached:\s+(\d+)/);
        const _match_swap_total = each.match(/^SwapTotal:\s+(\d+)/);
        const _match_swap_free = each.match(/^SwapFree:\s+(\d+)/);

        if (_match_total) {
            _current_total = Number(_match_total[1]);
        }
        else if (_match_free) {
            _current_free = Number(_match_free[1]);
        }
        else if (_match_cached) {
            _current_cached = Number(_match_cached[1]);
        }
        else if (_match_swap_total) {
            _current_swap_total = Number(_match_swap_total[1]);
        }
        else if (_match_swap_free) {
            _current_swap_free = Number(_match_swap_free[1]);
        }
    });

    const _current_used = _current_total - _current_free;
    const _active = _current_used - _current_cached;
    const _swap_used = _current_swap_total - _current_swap_free;
    
    return {
        total: _current_total * 1024,
        free: _current_free * 1024,
        cached: _current_cached * 1024,
        active: _active * 1024,
        usage:  ((_active / _current_total) * 100.0).toFixed(2),
        swap_total: _current_swap_total * 1024,
        swap_used: _swap_used * 1024,
        swap: ((_swap_used / _current_swap_total) * 100.0).toFixed(2)
    };
}

function mem_usage() {
    return new Promise(fulfill => {
        read_file('/proc/meminfo').then(meminfo => {

            const lines = meminfo.split('\n');
            let total = 0, free = 0, available = 0, cached = 0, buffers = 0;
            let swap_total = 0, swap_free = 0;

            for (const line of lines) {
                if (line.startsWith('MemTotal:')) total = parseInt(line.split(/\s+/)[1]);
                else if (line.startsWith('MemFree:')) free = parseInt(line.split(/\s+/)[1]);
                else if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]);
                else if (line.startsWith('Cached:')) cached = parseInt(line.split(/\s+/)[1]);
                else if (line.startsWith('Buffers:')) buffers = parseInt(line.split(/\s+/)[1]);
                else if (line.startsWith('SwapTotal:')) swap_total = parseInt(line.split(/\s+/)[1]);
                else if (line.startsWith('SwapFree:')) swap_free = parseInt(line.split(/\s+/)[1]);
            }

            // 🔧 csak a ténylegesen használt memória: összes - szabad - cache - buffer
            const used = total - free - cached - buffers;
            const swap_used = swap_total - swap_free;

            const response = {
                total,
                free,
                cached,
                active: used,
                usage: used,
                swap_total,
                swap_used,
                swap: swap_used
            };

            logger.info(`memory sensor: total ram detected ${(total / 1024 / 1024).toFixed(2)} GB`);
            logger.info(`memory sensor: total swap detected ${(swap_total / 1024 / 1024).toFixed(2)} GB`);

            fulfill(response);
        }, err => {
            if (!_fault) {
                logger.error('memory sensor: failed to read /proc/meminfo: ' + err);
                _fault = true;
            }
            fulfill();
        });
    });
}

function format_bytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0';
    const gb = bytes / 1024 / 1024;
    return gb.toFixed(2);
}

function sample(rate, format) {

    return new Promise(fulfill => {

        const _diff = Math.floor(Number(process.hrtime.bigint()) / 1000000) - _last_sampled;
        var _dirty = false;
        var _mem_promise = Promise.resolve();

        if (!_last_sampled || _diff > rate) {

            _last_sampled = Math.floor(Number(process.hrtime.bigint()) / 1000000);
            _mem_promise = mem_usage();
            _dirty = true;
        }
		_mem_promise.then(result => {
    if (result && typeof result.total === 'number' && result.total > 0) {
        if (_total_memory != result.total) {
            _total_memory = result.total;
            logger.info('memory sensor: total ram detected ' + _total_memory + ' GB');
        }

        if (_swap_total != result.swap_total) {
            _swap_total = result.swap_total;
            logger.info('memory sensor: total swap detected ' + _swap_total + ' GB');
        }

        record_sample(_free_history, result.free, _max_points);
        record_sample(_cache_history, result.cached, _max_points);
        record_sample(_active_history, result.active, _max_points);
        record_sample(_usage_history, result.usage, _max_points);
        record_sample(_used_swap_history, result.swap_used, _max_points);
        record_sample(_swap_history, result.swap, _max_points);
    } else {
       // logger.warn('⚠️ memory sensor: skipping invalid or empty result');
    }
            var _max = 0;

            const _output = format.replace(/{(\d+)}/g, function (match, number) { 
        
                switch (number) {
                    case '0':
                        return _total_memory;
                    case '1':
                        return _swap_total;

                    case '2':
                        _max = 100;
                        return _usage_history[_usage_history.length - 1];
                    case '3':
                        _max = 100;
                        return _usage_history.join();

                    case '4':
                        _max = 100;
                        return _swap_history[_swap_history.length - 1];
                    case '5':
                        _max = 100;
                        return _swap_history.join();

                    case '6':
                        _max = _total_memory;
                        return _free_history[_free_history.length - 1];
                    case '7':
                        _max = _total_memory;
                        return _free_history.join();

                    case '8':
                        _max = _total_memory;
                        return _cache_history[_cache_history.length - 1];
                    case '9':
                        _max = _total_memory;
                        return _cache_history.join();
                                                    
                    case '10':
    _max = _total_memory;
    return (_total_memory / 1024 / 1024).toFixed(2);
                    case '11':
                        _max = _total_memory;
                        return _active_history.join();
                                                     
                    case '12':
    _max = 100;
    const usedKB = _usage_history[_usage_history.length - 1] || 0;
    const totalKB = _total_memory || 1; // védelem null ellen
    const percent = (usedKB / totalKB) * 100;
    return percent.toFixed(2);
                    case '13':
                        _max = _swap_total;
                        return _used_swap_history.join();                        

                    case '14':
    _max = _total_memory;
    var _used_kb = _usage_history[_usage_history.length - 1] || 0;
    return (_used_kb / 1024 / 1024).toFixed(2); // GB-ban visszaadva
                    case '15':
                        return format_bytes(_used_swap_history[_used_swap_history.length - 1]);

                    default:
                        return 'null';
                }
            }); 

            fulfill({
    value: _output.trim(),
    min: 0,
    max: (_max / 1024 / 1024).toFixed(2)
});
        });
    });
}

function init(config) {
    
    if (config) {
        _max_points = config.max_points || 10;
    }

    logger.info('initialize: memory sensor max points are set to ' + _max_points);
    
    return 'memory';
}

function stop() {
    return Promise.resolve();
}

/* this will only be used for GUI configuration */

function settings() {
    return {
        name: 'memory',
        description: 'memory monitor',
        icon: 'pi-chart-pie',        
        multiple: false,
        ident: [],        
        fields: [
            { name: 'max_points', type: 'number', value: 300 },
        ]
    };
}

module.exports = {
    init,
    settings,
    sample,
    stop
};
