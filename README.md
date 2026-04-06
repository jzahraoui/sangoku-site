# Room Correction Helper

Room Correction Helper (RCH) is an open-source web application for advanced home theater calibration on Denon and Marantz AVRs using Audyssey. It works alongside REW (Room EQ Wizard) to import measurements, align speakers and subwoofers, generate correction filters, preview predicted results, and export an OCA file ready to load into compatible hardware.

The project is built for users who want more control than the standard Audyssey workflow offers while keeping a guided, browser-based interface.

![Room Correction Helper interface](https://sangoku.work/img/doc/interface-screenshot.png)

## Who This Is For

RCH is designed for users who want to go further than a default Audyssey run without giving up visibility into what the calibration is doing.

This project is a good fit if you:

- use a Denon or Marantz AVR with Audyssey
- already work with REW, or want a guided workflow around it
- want tighter control over timing, levels, crossovers, and subwoofer integration
- need a workflow that can start from `.ady`, `.mqx`, or manual REW measurements

RCH is probably not the right tool if you want a fully automatic one-click calibration process with no manual validation.

## Quick Start

### Basic workflow in 5 steps

1. Install a recent REW beta and enable the REW API server.
2. Open [https://sangoku.work/](https://sangoku.work/).
3. Import your `.ady` file from odd.wtf or the Audyssey app, or import `.mqx` if relevant.
4. Connect RCH to REW, then run averages, Time Align, and Align SPL.
5. Optimize subs, validate previews, and export your `.oca` file for AVR upload.

## What This Tool Does

RCH helps you turn raw room measurements into a usable room-correction configuration.

Typical use cases include:

- importing measurements from Audyssey-based workflows or manual REW sessions
- averaging multi-position measurements
- aligning speakers in time and level
- optimizing one or multiple subwoofers
- importing or exporting MSO-related data
- generating preview responses before committing changes
- exporting an OCA file for upload to the AVR

## Project Goal

The goal of RCH is to give the user a practical calibration toolbox, not a black box.

Instead of hiding the process, RCH exposes each important step of the workflow:

- measurement import
- averaging
- time alignment
- SPL alignment
- subwoofer optimization
- crossover and filter generation
- preview validation
- final OCA export

This makes it possible to build better room-correction results while keeping manual control over key decisions.

## When To Use RCH

Use RCH when you want a workflow that sits between raw measurement tooling and final AVR deployment.

Compared to a default AVR calibration flow, RCH gives you more control over:

- how measurements are imported and organized
- how speakers are aligned in time and SPL
- how one or several subwoofers are optimized
- how crossover decisions are validated through previews
- how the final OCA payload is generated and documented

## Supported Workflows

RCH supports two main usage styles.

### Basic workflow

For users working with Audyssey-generated measurements:

- import `.ady` files created from odd.wtf or the Audyssey MultEQ Editor app
- optionally import `.mqx` data from MultEQ-X workflows
- automatically load measurements into REW
- average positions, align speakers, optimize subs, and export OCA

### Advanced workflow

For users working directly in REW with their own microphone:

- generate an `.avr` file from odd.wtf
- make and manage measurements manually in REW
- use RCH for alignment, optimization, preview, and export

## Key Features

- Direct REW API integration
- Import of `.avr`, `.ady`, and `.mqx` project data
- Automatic measurement import into REW when connected
- English and French interface
- AVR configuration parsing and channel mapping display
- Multi-position averaging
- Speaker time alignment and SPL alignment
- Subwoofer tools for LPF reversion, alignment, EQ, and preview
- Optional all-pass filters for multi-sub optimization
- MSO export package generation and MSO Equalizer APO import
- Predicted preview generation for sub and speaker-plus-sub responses
- OCA export in odd.wtf or A1 Evo Acoustica compatible formats
- Settings file export for documenting a calibration session

## Inputs And Outputs

### Inputs

- `.ady` files from odd.wtf or the Audyssey mobile app
- `.mqx` files from MultEQ-X workflows
- `.avr` files describing the current AVR configuration
- REW measurements from manual workflows
- Equalizer APO exports from MSO

### Outputs

- calibrated data inside REW
- preview measurements for validation
- subwoofer export ZIP files for MSO workflows
- `.oca` calibration files for AVR upload
- plain-text settings reports documenting the generated configuration

## Requirements

To use the application effectively, you typically need:

- REW with API support enabled
- an Audyssey-compatible Denon or Marantz AVR
- odd.wtf for generating AVR files and loading OCA files, depending on workflow
- measurement data from Audyssey, MultEQ-X, or manual REW sessions

For advanced workflows, a calibrated microphone and solid REW knowledge are recommended.

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

If your change affects measurement handling, filter generation, MSO import/export, or OCA generation, include enough detail for reviewers to understand the expected audio behavior.

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
- RatNeuron for odd.wtf
- the users and testers who helped validate the workflows
- the open-source libraries used by this project

## License

This project is licensed under the GNU Affero General Public License v3. See the `LICENCE` file for details.
