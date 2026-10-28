


i need you to do requirement eng with me for the following meta tool

at its hart it manages a list of projects
each project maps to  1. a folder witch we will explain 2. a tmux session 3. some managed agent harnesses running in that tmux session in that dir

the main interface for now is a telegram bot 

after the user starts the bot and set it up we have some commands

/create_project  makes  a new project  and a idle agent in tmux and activate it

/proj  selects the active project (also creates an agent if we dont have any in that dir)

/create_agent  makes a new agent in current active project

/agent  selects the current agent

/delete deletes the current agent with a confirm and gos back to another agent in same dir (if we dont have any other agent we jump back to the manager mode)

/clear  resets the context of agent ( equal to /new in pi )

/manage :  the manager mode is for managing - this mode should be able to execute management commands as its tools and have needed tool to change the active mode - it also runs as an agent with pi-SDK on the parent folder containing all projects (the cwd)

each gateway like the telegram have an active mode we are either in management state or one of the projects with some agent is the active mode, the active mode should be appended as the footer of the response 


biggest source of truth is the subdirs in the PROJECTS_DIR so if the tmux or any other thing like the tmux session is not available make them 

you can use PROJECTS_DIR/.silky to store metadata about tmux sessions and windows (this is the source of truth if you cant find the tmux session for some res+
 )