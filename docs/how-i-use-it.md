# How I use agentbox

This is how I actually work with agentbox, day to day. It isn't the only way
to use it, but it's the setup I keep coming back to, and it shows what the
pieces are for better than a feature list does.

The short version: I hand work to agents in the morning, check on them from
wherever I am during the day, and sit down with them properly when I'm back at
a desk. The work never stops because I closed a laptop.

## Once: set it up

On a fresh VPS, with a DNS name pointed at it, it's two commands (the
[README](../README.md#install) has the details):

```bash
curl -fsSL https://github.com/jabezpauls/agentbox/releases/latest/download/install.sh -o install.sh
sudo bash install.sh --domain code.example.com
```

Then, on my laptop, the CLI, signed in to the box through the browser:

```bash
npm i -g @jabezpauls/agentbox
agentbox login https://code.example.com
```

And once, inside the box, I sign the agents in and give them GitHub: I run
`claude` (or `codex`) in a Workbench terminal and follow its sign-in, and
`gh auth login` so they can clone, push and open pull requests.

## Morning: give the crew its work

I start on my laptop. A new project gets cloned straight into the box, from a
terminal in the Workbench or from my own terminal with `agentbox attach`:

```bash
cd /workspace
git clone git@github.com:me/the-project.git
cd the-project
claude
```

Then I write down what I want done today and hand it out.

I don't hand it out to each agent myself, though. I use
[firstmate](https://github.com/kunchenguid/firstmate), which is optional but
has changed how I work. firstmate sits between me and the agents. I talk to
one agent, the first mate. It splits the work, starts a crew of other agents
to do it, each in its own git worktree, and comes back to me only with what I
actually need to know: a decision, a question, a pull request to look at. I
don't babysit five terminals.

What makes this work well on agentbox is that every crewmate is a real agent
in a real terminal. With firstmate's herdr backend each one gets its own tab,
so it shows up in the Workbench like anything else. Most of the time I leave
them alone. When I want to see what one is doing, or steer it, I click into
its pane and talk to it directly. Orchestration when I want it, the controls
when I need them.

Setting firstmate up is a few commands; see [firstmate](workbench.md#firstmate).

## During the day: close the laptop

At some point I close the lid and leave. On a laptop that would be the end of
it: the agents stop mid-task and wait for me.

Here nothing stops. The agents run on the server, so I put the laptop in my
bag and they keep going. On a train or between meetings I open my box on my
phone, see who is working and who is waiting on me, answer a question, and put
the phone away. When an agent needs me, the tab title and Home tell me before I
go looking.

## Back at a desk: attach

When I open the laptop again I don't reconnect to a web page and squint. I run:

```bash
agentbox attach
```

and my agents are in my own terminal, drawn by the herdr installed on my
laptop, as if they had been running on this machine all along. Keyboard,
mouse, scrolling, copy and paste all work the way they do locally. I pick up exactly where the morning left off.

## Seeing what got built

An agent that builds something web-shaped puts it in my Preview, and I watch it
change as the agent works. This is the part that surprises people coming from
hosted sandboxes: there is no list of things you're allowed to run. It's my
server. An agent can start any server on any port, and I can open it, look at
it on a phone-sized frame, and, when I want someone else to see it, share it
with a link or a passcode. When I stop sharing, the link stops working.

## Giving feedback that lands

Typing "make the second section shorter and move the table up" into a chat is
a poor way to give feedback on a plan or a page. So my agents don't ask me in
text. They put the page in front of me with Review, I click the heading or
select the sentence I mean, and I write my note on that exact spot, as many
notes as I like, at whatever level of detail. The agent gets every comment
attached to the thing it's about. It understands what I mean the first time
far more often than it does with a paragraph of instructions.

## Docs, PDFs and media, in the same place

Not everything I do is code. The Editor is VS Code, on the same files the
agents are working on, so it's also where I write. When I'm doing
documentation I install my company's documentation skill, have an agent draft
the document, and read the PDF or the LaTeX output right there in the editor,
next to its source. Uploading a folder of assets or downloading a finished
document is a drag and drop in Files, or `agentbox files` from my laptop.

## Keeping the server lean

A VPS has a small disk and it's the one thing I watch. Code and the projects
I'm working on live on the box. Media doesn't: big files go to a cheap S3
bucket instead of the server's disk, and the box stays small, fast and cheap.
System shows me how full the disk is before it becomes a problem.

## If you're starting out

- **Start with one project and one agent.** Get the loop of handing off work,
  closing the laptop and checking in from the phone into your hands first.
- **Add an orchestrator when you have more work than attention.** firstmate is
  what I use; anything that runs its agents in terminals shows up in the
  Workbench the same way.
- **Ask for previews and reviews by name.** "Put it in my preview" and "show
  me the plan for review" are all an agent needs to hear; the box tells it how.
- **Use `agentbox attach` at a desk and the browser everywhere else.** Same
  agents, same sessions, whichever you pick up.
- **Watch the disk, not the CPU.** Agents wait on models far more than they
  compute. Storage is what fills up.
