# Room Correction Helper

Room Correction Helper (RCH) is an open-source browser-based application for advanced home theater calibration on Denon and Marantz AVRs using Audyssey. It works alongside REW (Room EQ Wizard) to measure, align speakers and subwoofers, generate correction filters and preview predicted results, then transfers the calibration directly into the receiver through the RCH Bridge — a small local companion program that drives the AVR over the network (Audyssey measurement included).

The project is built for users who want more control than the standard Audyssey workflow offers while keeping a guided, browser-based interface.

![Room Correction Helper interface](https://sangoku.work/img/doc/interface-screenshot.png)

## Who This Is For

RCH is designed for users who want to go further than a default Audyssey run without giving up visibility into what the calibration is doing.

This project is a good fit if you:

- use a Denon or Marantz AVR with Audyssey
- already work with REW, or want a guided workflow around it
- want tighter control over timing, levels, crossovers, and subwoofer integration
- need a workflow that can start from a bridge-driven Audyssey measurement session, `.ady`, `.mqx`, `.liveproject`, or manual REW measurements

RCH is probably not the right tool if you want a fully automatic one-click calibration process with no manual validation.

## Quick Start

### Basic workflow in 5 steps

1. Install a recent REW beta and enable the REW API server; download and launch the RCH Bridge from the Resources tab.
2. Open [https://sangoku.work/](https://sangoku.work/).
3. Complete the operational chain: connect REW, connect the bridge, register your AVR (IP or network discovery).
4. Measure with the built-in Audyssey assistant (or import `.ady`/`.mqx`/`.liveproject` measurements, or measure manually in REW), create averages, run Time Align, load your target curve in REW, and run Align SPL.
5. Optimize subs, validate previews, save the Reference and Flat filter banks, and transfer the calibration into the AVR.

## What This Tool Does

RCH helps you turn raw room measurements into a usable room-correction configuration.

Typical use cases include:

- measuring through the bridge-driven Audyssey assistant
- importing measurements from Audyssey-based workflows or manual REW sessions
- averaging multi-position measurements
- aligning speakers in time and level
- optimizing one or multiple subwoofers
- importing or exporting MSO-related data
- generating preview responses before committing changes
- transferring the calibration directly into the AVR

## Project Goal

The goal of RCH is to give the user a practical calibration toolbox, not a black box.

Instead of hiding the process, RCH exposes each important step of the workflow:

- measurement (assistant or import)
- averaging
- time alignment
- SPL alignment
- subwoofer optimization
- crossover and filter generation
- preview validation
- filter banks and final calibration transfer

This makes it possible to build better room-correction results while keeping manual control over key decisions.

## When To Use RCH

Use RCH when you want a workflow that sits between raw measurement tooling and final AVR deployment.

Compared to a default AVR calibration flow, RCH gives you more control over:

- how measurements are taken, imported, and organized
- how speakers are aligned in time and SPL
- how one or several subwoofers are optimized
- how crossover decisions are validated through previews
- what exactly is transferred into the AVR, and how it is documented

## Supported Workflows

RCH supports two main usage styles. Both require the full operational chain: REW connected, RCH Bridge connected, and the AVR registered — the receiver configuration is always read live from the connected AVR, files only provide measurements.

### Basic workflow

For users working with Audyssey measurements:

- measure with the built-in assistant (the bridge drives the AVR sweeps and imports each impulse response into REW), or import `.ady`, `.mqx`, or Dirac Live `.liveproject` measurement files
- average positions, align speakers, optimize subs
- save the Reference and Flat filter banks, then transfer into the AVR

### Advanced workflow

For users working directly in REW with their own microphone:

- make and manage measurements manually in REW, named after the detected channels of the connected AVR
- use RCH for alignment, optimization, preview, banks, and transfer

## Key Features

- Direct REW API integration
- RCH Bridge integration: AVR registration (IP or SSDP discovery), live receiver configuration, operational chain gating
- Bridge-driven Audyssey measurement assistant with live impulse response import and subwoofer level matching
- Import of `.ady`, `.mqx`, and Dirac Live `.liveproject` measurement data
- Automatic measurement import into REW when connected
- English and French interface
- AVR configuration display synthesized live from the receiver
- Multi-position averaging
- Speaker time alignment and SPL alignment
- Subwoofer tools for LPF reversion, alignment, EQ, and preview
- Optional all-pass filters for multi-sub optimization
- MSO export package generation and MSO Equalizer APO import
- Predicted preview generation for sub and speaker-plus-sub responses
- Reference/Flat filter banks and direct calibration transfer (dry-run validation, per-channel progress, cancellation)
- Session export/import (`.json`) with continuous auto-save
- Settings file export for documenting a calibration session

## Inputs And Outputs

### Inputs

- measurements taken by the bridge-driven Audyssey assistant
- `.ady` files from the Audyssey mobile app
- `.mqx` files from MultEQ-X workflows
- Dirac Live `.liveproject` files
- REW measurements from manual workflows
- Equalizer APO exports from MSO
- RCH session files (`.json`)
- target curves loaded in REW for SPL alignment and validation

### Outputs

- calibrated data inside REW
- preview measurements for validation
- subwoofer export ZIP files for MSO workflows
- calibration transferred directly into the AVR (Reference and Flat banks)
- calibration archive download (`.rch.json`) for inspection
- RCH session files (`.json`)
- plain-text settings reports documenting the generated configuration

## Requirements

To use the application effectively, you typically need:

- REW with API support enabled
- the RCH Bridge running locally (binaries available in the Resources tab)
- an Audyssey-compatible Denon or Marantz AVR, reachable on the local network
- the full operational chain (REW + bridge + registered AVR) for all workflow steps
- measurement data from the assistant, Audyssey, MultEQ-X, Dirac Live, or manual REW sessions

For advanced workflows, a calibrated microphone and solid REW knowledge are recommended.

For Align SPL and final validation, a target curve should also be loaded in REW.

## Running The Project Locally

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run build
npm run preview
npm run test:smoke
npx eslint src/
```

Notes:

- the project uses Vite for development and production builds
- the app connects to the REW API at `http://localhost:4735` by default
- the repository currently declares `node >= 16`, and the deployment workflow runs on a modern Node.js version

## Tech Stack

- Vite
- Knockout.js
- mathjs
- decimal.js
- JSZip
- js-yaml
- FileSaver.js

## Contributing

Contributions are welcome.

You can help by:

- reporting bugs
- improving documentation
- proposing UX or workflow improvements
- fixing calibration edge cases
- adding tests for critical measurement and export paths
- submitting pull requests

Recommended contribution flow:

1. Fork the repository.
2. Create a focused branch for a single change.
3. Run the app locally and verify the affected workflow.
4. Run `npm run test:smoke` and `npx eslint src/` before submitting.
5. Open a pull request with a clear description of the problem, the fix, and any calibration impact.

If your change affects measurement handling, filter generation, MSO import/export, or the calibration transfer path, include enough detail for reviewers to understand the expected audio behavior.

### Optimizer Changes

The multi-sub optimizer is intentionally split by responsibility so contributors can work in a focused area without growing one large file again.

- `src/multi-sub-optimizer.js` remains the compatibility entry point used by the UI and tests; the implementation lives in `src/optimizer/multi-sub-optimizer.js`, with public instance wrappers in `src/optimizer/facade-methods.js`. Keep public method names stable unless the callers are migrated in the same change.
- Put DSP and response math in `src/optimizer/response.js`, scoring in `src/optimizer/evaluation.js`, parameter grids in `src/optimizer/params.js`, reports in `src/optimizer/report.js`, and search strategies in the dedicated `src/optimizer/*-search.js` modules.
- Prefer small, named helpers with focused tests over adding more logic directly to the facade.
- For optimizer changes, run `npm run test:multi-sub-optimizer-general`, `npm run test:genetic-algorithm`, and `npm run test:multi-sub-optimizer-all` before opening a pull request.

## Useful Links

- Website: [https://sangoku.work/](https://sangoku.work/)
- GitHub repository: [https://github.com/jzahraoui/sangoku-site](https://github.com/jzahraoui/sangoku-site)
- HCFR discussion: [https://www.homecinema-fr.com/forum/acoustique-correction-active-et-logiciels-de-mesure/room-correction-helper-pour-preampli-audyssey-t30137090.html](https://www.homecinema-fr.com/forum/acoustique-correction-active-et-logiciels-de-mesure/room-correction-helper-pour-preampli-audyssey-t30137090.html)
- AVS Forum thread: [https://www.avsforum.com/threads/sangoku-room-correction-helper.3320856](https://www.avsforum.com/threads/sangoku-room-correction-helper.3320856)
- YouTube playlists: [https://www.youtube.com/@Sangoku-Z/playlists](https://www.youtube.com/@Sangoku-Z/playlists)
- REW: [https://www.roomeqwizard.com/](https://www.roomeqwizard.com/)

## Disclaimer

This project is provided for experimental and informational purposes only.

Before sending any generated configuration to your AVR, verify the parameters carefully. Incorrect settings, measurements, gains, or polarity changes can produce poor results and may put hardware at risk. You remain fully responsible for what you load onto your system.

## Acknowledgments

- John Mulcahy for REW
- RatNeuron for odd.wtf, which powered the pre-2.0 upload workflow
- the users and testers who helped validate the workflows
- the open-source libraries used by this project

## License

This project is licensed under the GNU Affero General Public License v3. See the `LICENCE` file for details.
