# ReaperCode

Reaper Code is a coding agent heavily inspired by the [Pi coding agent](https://github.com/mariozechner/pi). 

My primary goal with this project is to use it as a personal testing ground for cutting-edge **harness engineering techniques**. Because I actively use it and test new ideas here, it will continue to evolve with the latest agentic patterns.

## The Philosophy & Lessons Learned

I learned a lot while building this project, mostly **how *not* to build a coding agent in 100 different ways**. I ended up ripping out 90% of the initial stuff to dramatically simplify the architecture, and it worked great. 

As I continue to use the agent daily, I will keep iterating and improving it based on my own dogfooding experience. 

## Current State & Roadmap

- **Sub-Agent Architecture**: Reaper can currently be used as a sub-agent for other agents. As I learn more about sub-agent architectures and best patterns, I will continue to refine and implement them here.
- **Web UI (Planned)**: I am planning to implement a Web UI for this agent, similar to the agent canvas/workspace in OpenHands.
- **Offensive Security Fork (WIP)**: I am also building a red-team operator/offensive coding agent forked from this project. It will include specific pieces for offensive cybersecurity and red-team operations.

## Disclaimer & Maintenance

I will keep maintaining Reaper Code for as long as I am personally using it, but I **cannot guarantee any future maintenance**. 

If you want to use this, you are completely welcome to use it and legally steal the code. (Though if you have enough time, building your own is a great learning experience!)

## Getting Started

If you want to run it locally:

```bash
git clone https://github.com/gowtham-uj/ReaperCode.git
cd ReaperCode
npm install
npm run build

# Run the agent
npm run reaper
```
