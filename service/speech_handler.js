// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// Copyright 2017 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const stream = require('stream');
const events = require('events');
const path = require('path');

const snowboy = require('snowboy');

const SpeechRecognizer = require('./speech_recognizer');

class DetectorStream extends stream.Transform {
    constructor() {
        super();

        let models = new snowboy.Models();
        /*for (let p of ['silei', 'gcampagn']) {*/
             models.add({
                 file: path.resolve(module.filename, '../data/gcampagn.pmdl'),
                 sensitivity: '0.4',
                 hotwords : 'almond'
             });
        /*}*/

        this._detector = new snowboy.Detector({
            resource: path.resolve(module.filename, '../data/snowboy.res'),
            models: models,
            audio_gain: 2
        });

        this._detector.on('silence', () => {
        });
        this._detected = false;
        this._detector.on('hotword', (index, hotword, buffer) => {
            this._detected = true;
            this.emit('hotword', hotword);
        });
    }

    finishRequest() {
        console.log('Request finished');
        this._detected = false;
    }

    _transform(chunk, encoding, callback) {
        if (!this._detected)
            this._detector.runDetection(chunk);
        if (this._detected)
            this.push(chunk);
        callback();
    }
}

module.exports = class SpeechHandler extends events.EventEmitter {
    constructor(platform) {
        super();
        this._platform = platform;
        this._pulse = platform.getCapability('pulseaudio');

        this._recognizer = new SpeechRecognizer({ locale: this._platform.locale });
        this._recognizer.on('error', (e) => {
            this._detector.finishRequest();
            this.emit('error', e);
        });

        this._hotwordEnabled = false;
    }

    setHotwordEnabled(enabled) {
        this._hotwordEnabled = enabled;
    }

    start() {
        this._stream = this._pulse.createRecordStream({ format: 'S16LE', rate: 16000, channels: 1 });

        this._stream.on('state', (state) => {
            console.log('Record stream is now ' + state);
            if (state === 'ready')
                this.emit('ready');
        });
        this._stream.on('error', (e) => this.emit('error', e));

        this._detector = new DetectorStream();
        this._detector.on('hotword', (hotword) => {
            if (!this._hotwordEnabled)
                return;

            console.log('Hotword ' + hotword + ' detected');
            this.emit('hotword', hotword);
            let req = this._recognizer.request(this._detector);
            req.on('hypothesis', (hypothesis) => this.emit('hypothesis', hypothesis));
            req.on('done', (status, utterance) => {
                if (status === 'Success') {
                    console.log('Recognized as "' + utterance + '"');
                    this.emit('utterance', utterance);
                } else {
                    console.log('Recognition error: ' + status);
                }
                this._detector.finishRequest();
            });
        });
        this._stream.pipe(this._detector);
    }

    stop() {
        if (!this._stream)
            return;
        this._stream.end();
        this._stream = null;
        this._recognizer.close();
    }
}
