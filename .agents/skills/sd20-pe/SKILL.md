---
name: sd20-pe
description: Seedance 2.0 prompt spec — the finished prompt structure Compose returns, the official Dreamina Seedance 2.0 prompt guide (core formula, image/audio/video reference syntax, text rendering, editing and extension), and the Vibe Creating method for distilling user input.
models:
  - seedance
  - seedanceFast
  - seedanceMini
---

# Seedance 2.0 Prompt Spec

Three parts. **Part 0 fixes the SHAPE of the finished prompt.** Part 1 is the official Dreamina guide — the syntax and the capabilities. Part 2 is the Vibe Creating method — how to decide what the prompt should say. Where Part 1 and Part 2 disagree on wording, the guide wins; where either disagrees with Part 0 on layout, Part 0 wins.

## Part 0 — The Finished Prompt

When the caller asks for a prompt, return the prompt and nothing else — no judgement line, no action label, no notes section. Lay it out in this order, omitting any block the shot has nothing for. Never pad a block to look complete.

1. **Subject and reference definitions** — one sentence per identity-bearing reference, in the guide's own syntax:
   `Use the woman from Image 1 and Image 2, maintaining consistent facial features and clothing.`
   `Refer to the layout of the pine clearing in Image 3; do not use the people in it.`
   `Refer to the storyboard composition in Image 6, presenting its frames in the predefined order.`

2. **Media binding** — one sentence per attached audio or video reference:
   `The woman speaks with the voice of Audio 1.`
   `Refer to the camera movement in Video 1, keeping the cinematography consistent.`

3. **The shot body** — the events in order, written to the guide's core formula: **subject + motion + environment + camera movement/cut + aesthetic + audio**. One `Shot N:` block per shot when the piece has several; a single shot needs no label. Address every subject by its Image number.

4. **Look** — one sentence for style, grade and texture, when the material states one.

5. **Constraint tail** — close with: `HD, cinematic texture, natural colors. Keep it subtitle-free, avoid generating any text or subtitles. Do not generate watermarks or logos. Do not generate duplicate characters.` Omit the subtitle clause when the shot deliberately renders text or subtitles.

Hard rules for this model:

- **NO first-frame or last-frame language.** Seedance 2.0 has no keyframe control. Never write that the shot opens on, passes through or ends on the composition of an image. Ordered composition comes only from a storyboard reference image, as Part 1 describes.
- **NO timestamps.** Write plain event-order prose; the sequence of events carries the time.
- **Never invent a reference number.** Cite only images, audio and video that are actually attached.
- **Aspect ratio, duration, resolution and the audio toggle are parameters, not prompt text.**

## Part 1 — Official Dreamina Seedance 2.0 Prompt Guide

## Basic Prompting Techniques

Dreamina Seedance 2.0  boasts exceptional **semantic understanding** and **multimodal interaction** capabilities. To create high-quality videos, we recommend focusing your instructions on the following dimensions. The model is designed to precisely capture and reconstruct every detail provided:



### The Core Prompt Formula

Dreamina Seedance 2.0 excels at following **natural language logic**. You can flexibly combine the following elements based on your creative needs:

**Subject + Motion + Environment (Optional) + Camera Movement/Cut (Optional) + Aesthetic Description (Optional) + Audio (Optional)**

**Subject + Motion + Environment (Optional) + Camera Movement/Cut (Optional) + Aesthetic Description (Optional) + Audio (Optional)**

- **Subject + Motion:** The logical foundation of your generation. Clearly define **"Who"** is performing **"What action."**

- **Environment + Aesthetics:** Define the overall tone by describing the spatial background, lighting details, or specific visual styles.

- **Audio:** Advanced instructions can include **ambient sound effects** to achieve an immersive, synchronized audiovisual output.

### Multimodal Reference & Control

Beyond text descriptions, you can "feed" visual or auditory assets to lock in the** ideal baseline state** for your video. Dreamina Seedance 2.0 supports deep referencing across images, audio, and video:

- **Explicit Referencing:** Clearly specify the reference source within your prompt (e.g., *"Use the composition of Image 1"* or *"Match the motion of Video 2"*).

- **Precision Transfer:** The model automatically extracts core features from the reference material and merges them with your text. This ensures the output maintains high fidelity and predictability while still allowing for creative variation.



---



## New Capabilities in Dreamina Seedance 2.0



### Text Rendering

Dreamina Seedance 2.0 supports generating common text across multiple scenarios, including **T2V (Text-to-Video)**, **I2V (Image-to-Video)**, **R2V (Reference-to-Video)**, and **V2V (Video-to-Video)**.

- **Key Capabilities:**

    - **Intelligent Adaptation:** The model automatically matches font styles and colors to the specific context of your scene for seamless visual integration.

    - **Granular Control:** You can explicitly define the following attributes within your prompts:

        - **Style:** Color and font style.

        - **Dynamic Behavior:** How the text appears (entrance style) and the specific timing of its appearance.

        - **Layout:** Precise positioning within the frame.

- **Best Practices****：**

    - **Use Common Vocabulary:** Use widely recognized words and familiar phrases. The model performs best with standard English lexicon.

    - **Avoid Rare or Obscure Words:** High-complexity or "dictionary-deep" words may lead to inconsistencies. Simpler, high-frequency words ensure higher rendering accuracy.

    - **Minimize Special Symbols:** Limit the use of complex symbols or non-standard punctuation to maintain visual clarity and font fidelity.

#### Slogan

- **Prompt Techniques**

    - **1. The Universal Formula**

        - To achieve precise text rendering as you wish, structure your prompt as follows:

            - ***[Text Content] + [Timing] + [Positioning] + [Entrance/Appearance Style], [Visual Attributes (Color, ******Font Style******)]***

    - **2. Visual Style & Consistency**

        - **Contextual Adaptation:** Dreamina Seedance 2.0 automatically identifies the scene's context to match the most appropriate font aesthetic.

        - **Precision Requirements:** If your project requires strict adherence to specific visual standards (e.g., brand consistency), please refer to section **[2****.2.2 Multi-Image Reference: Logo Reference]** for advanced guidance.

- **Usage Examples**

    |    [0987.mp4]<br>    ---<br>[image]<br>    Hand-drawn comic style: Two people are sitting around a table enjoying the roast chicken shown in **Image 1**, with a friendly and joyful atmosphere. The frame then gradually blurs, and the text “Bite”“Laugh”“ Dreamina Seedance”in order appears in the center of the screen.|
    |---|

#### Subtitle

- **Common Syntax:**

    - ***Display subtitles at the bottom-center with the text. The subtitles must be perfectly synchronized with the audio rhythm and pacing.***

- **Usage Examples**

    |    **Voiceover**|    **Dialogue**|
    |---|---|
    |    [111.mp4]<br>    ---<br>[image]<br>    **Camera pulls back and rotates, keeping the baby in Image 1 centered in the frame at all times, creating a commercial showcasing this handbag.Voiceover (in a gentle, mature, intellectual female voice):***Time pens poetry upon the leather,Years gild the bag with tenderness.Crafted from handpicked full-grain vegetable-tanned cowhide,Every texture holds the warmth of handcrafted artistry.***Text Integration: Display the voiceover as subtitles centered at the bottom of the screen, with perfect timing synchronization to the audio.**|    [3456.mp4]<br>    ---<br>[image]<br>    r2v：An animated shot of these two people chatting in a fast-food restaurant in image 1. The man first speaks in a playful tone: "You're always late. Do you really have the heart to keep me waiting this long?" Then the woman smiles and replies: "Don't meddle in my business."Text integration: Present the dialogue as subtitles at the bottom center of the screen. The subtitles should appear sequentially as each character speaks.<br>    |

    

#### Speech Bubble

- **Common Syntax：**

    - ***[Character] says, "[Dialogue]." Speech bubbles appear around the character containing the spoken text.***

- **Usage Examples**

|[02177122839971400000000000000000000ffffac191c03703e9f.mp4]<br>---<br>[image]<br>The two characters from **Image 1**, both dressed in sportswear, are running on the school playground. The girl looks at the boy, smiling confidently as she says: "We can definitely do it!". Cut to a close-up of the boy. He hesitates and replies: "Are you sure?". Cut back to a medium close-up of the girl. She speaks in a light, upbeat tone: "Yes!" Her demeanor is bright and resolute. Speech bubbles containing the corresponding lines appear around the speaking character.|[02177123057108500000000000000000000ffffac1801f26c2cd9.mp4]<br>---<br>[image]<br>[image]<br>Refer to the character design of the girl in **Image 1 **and **Image 2**. The scene is set in an apple field: the girl picks one apple, takes a bite, smiles and says "This is the real deal!". A speech bubble pops up beside the girl, with this line written inside.|
|---|---|





### **Image Reference**

> Dreamina Seedance 2.0 supports **multi-perspective references** for subjects, as well as **multi-image referencing** for scene layouts, storyboards, and more.
> 
> If your creative process requires a specific order (e.g., for storyboarding or sequential motion), please **upload your images in the desired sequence**. You can then use specific identifiers in your prompt for precise control:
> 
> - **Syntax:** Refer to **"Image 1," "Image 2," ... "Image N"** to accurately map each reference to your instructions.
> 
> 

- Simply identify the reference objects clearly. The model can process instructions including, but not limited to, the following examples.

#### Multi-View Subject Reference

- **Common Syntax:**

    - ***Refer to/Extract/Combine/Use**** the ****[Subject]**** from ****[Image N]**** to generate ****[Scene Description]****, maintaining consistent ****[Subject]**** features.***Multi-view Subject Reference**

- Product

    |    **Consumer Electronics** |    **Home & Lifestyle**|
    |---|---|
    |    [000000.mp4]<br>    ---<br>[image]<br>    <br>[image]<br>    <br>[image]<br>    <br>    Use the Projector shown in image 1, image 2 and image 3. Replace the original background with a commercial advertising background, and place the Projector on the chair. The camera first focuses on a close-up shot of Projector， then quickly rotates 360° with Projector as the main subject and flips over, clearly showing the front, side and back of each Projector.|    [92992.mp4]<br>    ---<br>[image]<br>    <br>[image]<br>    <br>    In a home furnishing store, show the throw pillows as shown in Reference image 1 and 2 in a medium shot. Then smoothly push the camera in for a close-up of the throw pillows. Next, a hand naturally enters from off-screen and gently picks up the throw pillow. The camera follows the slight rotation of the hand to showcase the throw pillow.|

    

- Character：

    |    [02177123203224600000000000000000000ffffac177869263fe7.mp4]<br>    ---<br>[image]<br>[image]<br>[image]<br>    Refer to the image of the woman in **Image 1**, **Image 2** and **Image 3**, and generate a scene of her eating a cake in a coffee shop.|
    |---|



#### **Multi-Image Reference** 

- **Common Syntax:**

    - ***Refer to / Extract / Combine / Follow the [Description of referenced elements] from [Image N] to generate [Scene Description], while maintaining the consistency of [Referenced Elements].***

|**Logo reference**|**Multi-Subject Reference**|**Multi-Element Reference**|**Multi-Panel Storyboard Reference**|**Storyboard Reference**|
|---|---|---|---|---|
|[db.mp4]<br>---<br>[image]<br>[image]<br><br>The scene is set on an aerial corridor in a neon-drenched futuristic metropolis, where flying vehicles and holographic ads intertwine. Featuring the girl from Reference** Image 2**, the sequence opens with a medium shot of her releasing a silver floating lantern embedded with a holographic projection. The camera then pulls back to reveal floating lanterns flooding the sky, which gradually converge at the center of the frame to form the logo from Reference **Image 1**. The entire piece adopts a 3D cyberpunk sci-fi animation style.<br>|[02177106296346000000000000000000000ffffac14add0e46162.mp4]<br>---<br>[image]<br>[image]<br>Using the cat and dog from the reference **Image 1** and **Image 2** as prototypes, the scene unfolds in a cozy apartment. The dog is lying on the ground eating dog food when the cat approaches, extending a paw to nudge the dog. The dog pauses its meal upon noticing the cat, and the cat snuggles up next to the dog. The entire scene features a warm color tone.<br>|[888.mp4]<br>---<br>[image]<br>[image]<br>[image]<br>[image]<br>[image]<br><br>The scene is set in the restaurant from **Image 4** with people coming and going. The girl from **Image 1** , wearing the clothes from **Image 2** , is organizing the items on the counter. The boy, a customer, from **Image 3** approaches her to ask for her contact information. The logo from **Image 5** remains in the bottom right corner throughout.<br>|[02177106761913900000000000000000000ffffac183fcbc3432d (2).mp4]<br>---<br>[image]<br>Refer to the storyboard in **Image 1** to create an intense high-energy fight sequence. All storyboard frame compositions from **Image 1** shall be presented in strict predefined order, after which the two characters engage in fierce, fast-paced combat.<br>|[02177106052899700000000000000000000ffffac177df7b634c9.mp4]<br>---<br>[image]<br>[image]<br>[image]<br>[image]<br>Refer to the storyboard composition in **Image 3**. A girl (her character design refers to **Image 1**) is waiting for her father to finish cooking, and she says: “아빠, 배고파요! 밥 다 됐어요?”Then the camera pans right and cuts to the frame and composition shown in **Image 4.** The father (his character design refers to **Image 2**) replies to her: “거의 다 됐어, 조금만 기다려!“Next, the camera cuts back to a close-up shot of the daughter's slightly disappointed facial expression, and she says: “아직 멀었어요? 맛있는 냄새 나는데...”Then the shot switches to a close-up of the father's face, and he says: “이제 진짜 금방이야. "빨리빨리" 하지 말고 손부터 씻고 와!”|



### **Audio Reference**

> - Dreamina Seedance 2.0 supports audio references (Note: audio-only uploads are not supported).
> 
>     - You can use audio to reference specific voice characteristics or to drive lip-sync animations.
> 
>     - If your generation requires a specific sequence, please upload the files in order. You can use **"Audio 1," "Audio 2," ... "Audio n"** in your prompts for precise mapping. 
> 
>     - Simply ensure that the relationship between the generated content and the reference source is clearly defined.
> 
> 

#### Voice Reference

- **Common Syntax:**

    - ***[Character] says: "[Dialogue]," referencing the voice from [Audio N].***

|**Voiceover**|**Dialogue**|
|---|---|
|[888.mp4]<br>---<br>[image]<br>[image]<br>[audio 1.mp3]<br>Fixed shot with shallow depth of field: The character from** Image 1** stands motionless, while the surrounding crowd flows rapidly in blurred motion.<br>A soft blur transition leads to the panoramic view of mountains and wilderness in **Image 2**. The camera slowly pushes toward the distance to reveal the forest. Next, the shot cuts to an atmospheric close-up inside the forest, then switches to a close-up of a tent, followed by a shot of a flowing stream.<br>Meanwhile, a female voiceover with the vocal timbre from **Audio 1 **delivers the line as the camera pulls back: "Come, amidst the mountains and under the sun, embrace the gifts bestowed by the wilderness."<br>Afterwards, the frame fades to dimness, and the white  text "Dreamina Seedance Camping" appears at the center of the screen.|[02177107390717400000000000000000000ffffac177d3abfe19a (1).mp4]<br>---<br>[image]<br>[image]<br>[audio 1.mp3]<br>[audio 2.mp3]<br>The man from **Image 1**  and the woman from **Image 2 **are chatting at a sun-drenched outdoor cafe. The man speaks with the voice of **Audio 2** , saying with a casual shrug: "So, I was thinking, we should totally hit up that new spot tonight." The woman responds with the voice of **Audio 1**, leaning in and laughing: "I'm down, but only if you're picking up the tab this time!" Natural sunlight filters through the scene with a shallow depth of field. The characters exhibit expressive hand gestures, realistic facial expressions, and perfectly synchronized lip movements to the dialogue.|

#### Audio Content Reference

- **Common Syntax:**

    - ***[Intended Timing/Trigger Moment] + [Audio N]***

|**Dialogue-to-Video**|**BGM Integration**|
|---|---|
|[02177107750166100000000000000000000ffffac14571b835403.mp4]<br>---<br>[image]<br>[audio 1.MP3]<br>The two people in **image 1** have a conversation according to **Audio 1**，The man says: “La cosa está dentro. La contraseña es la fecha de nacimiento de tu madre.”The woman takes it and responds: “Entendido. El próximo punto de contacto ha cambiado. Espera la señal segura.”<br>|[02177057178405500000000000000000000ffffac190f81a66765.mp4]<br><br>---<br>[clip]<br>video 1<br>[audio1.MP3]<br>Extend the **Video 1** duration. Tilt the camera upward, and play **Audio1** simultaneously as the camera movement begins.<br>|



### **Video Reference**

> Dreamina Seedance 2.0 supports video-based referencing.
> 
> - If your workflow requires a specific sequence, please upload the files in order. You can use **"Video 1," "Video 2," ... "Video n"** in your prompts for precise mapping.
> 
> - Simply ensure that the relationship between the generated content and the reference source is clearly defined.
> 
> 

#### Motion Reference

- **Common Syntax:**

    - ***Refer to the [Motion Description] from [Video N] to generate [Scene Description], keeping the motion details consistent.***

|**Cinematic**|**Marketing**|
|---|---|
|[02177088863493400000000000000000000ffffac177869f630ba.mp4]<br>---<br>[image]<br>[image]<br>[oYfOIAAjTCBjzFyACeLIAEGV3Al7joAEEKenEH_a=0&ch=0&cr=0&dr=0&er=0&lr=default&&br=17756&bt=17756&cs=0&ds=3&mime_type=video_mp4&qs=13&rc=ajhkcXk5cjU2OTczNGllM0BpajhkcXk5cjU2OTczNGllM0BlYnIvMmRrZS1hLS1kXy9zYSNlYnIvMmRrZS1hLS1kXy9zcw%3D%3D&cquery=.mp4]<br>video 1<br>Refer to the character movements and shot language in **Video 1** to create a fight scene with the character from **Image 2** on the left and the character from **Image 1 **on the right. Include intense background music.|[02177090597386000000000000000000000ffffac191c036d645e.mp4]<br>---<br>[02177090233056200000000000000000000ffffac191067e58961.mp4]<br>video 1<br>Referencing the running shape of the horse in the **Video 1**, generate a scene: a golden steed runs on the grassland, then freezes its magnificent running posture and turns into a horse-shaped gold pendant.|

#### Camera Motion Reference

- **Common Syntax:**

    - ***Refer to the [Camera Movement Description] from [Video N] to generate [Scene Description], keeping the cinematography consistent.***

    |    [00009.mp4]<br>    <br>    ---<br>    [clip]<br>    video 1<br>[image]<br>    <br>    Referring to the camera movement in **Video 1**, create a concept video for a science and technology park, with the tall building in the image as the visual center, also using a first-person dive perspective, to reflect the sense of technology in the park from **Image 1**.|
    |---|

    

#### **Visual Effects (VFX) Reference**

- **Common Syntax:**

    - **Refer to the [VFX Effects Description] from [Video N] to generate [Scene Description], keeping the special effects consistent.**

|**Cinematic**|**Creative FX** |
|---|---|
|[02177201016670600000000000000000000ffffac190a1efca115.mp4]<br>---<br>[clip]<br>video1<br>[image]<br>Refer to the golden particle effects in **Video 1**, so that when the character in **Image 1** plays the flute, the same particle effects surround their body.<br>|[02177052561938800000000000000000000ffffac183e64e97b7f.mp4]<br>---<br>[clip]<br>video 1<br>[image]<br>Refer to the special effects shown in **Video 1 **to generate identical wings for the girl in **Image 1**, ensuring the wing formation trajectory follows the exact same motion path and sequence depicted in the video.|



### **Video Editing**

- Dreamina Seedance 2.0 supports professional video editing, including element manipulation (add/remove/modify), video extension (forward and backward), and track alignment.

    - If your project requires a specific sequence, please upload the files in order. You can use "video 1," "video 2," ... "video n" in your prompts for precise mapping.

#### Element Manipulation (Add, Remove, Modify)

- **Common Syntax:**

    - **Add Elements**: 

        - ***At [Timestamp/Timing] and [Spatial Location] of [Video N], add [Description of intended element].***

    - **Remove Elements**: 

        - Remove **[Element to be deleted]** from **[Video N]**, keeping the rest of the video content unchanged.

    - **Modify Elements**:

        - Replace **[Description of element to be changed]** in **[Video N]** with **[Description of intended element]**.

|**Add Elements**|**Remove Elements**|**Modify Elements**|
|---|---|---|
|[02177105813203400000000000000000000ffffac183fc5b03351.mp4]<br>---<br>[02177105941672500000000000000000000ffffac177d3ad676a2 (1).mp4]<br>video 1<br>Add snacks such as fried chicken and pizza to the countertop in **Video 1.**|[02177107974855300000000000000000000ffffac1937dc70f00a.mp4]<br>---<br>[02177107923197300000000000000000000ffffac15b9d17a940a.mp4]<br>video 1<br>Remove everything that isn't office stuff from the table in **Video 1**, keeping the rest of the video content unchanged.|[clip]<br>---<br>[clip]<br>video 1<br>[image]<br>image1<br><br><br>Replace the perfume featured in **Video 1** with the face cream from **Image 1,** with all original motions and camera work preserved.|

#### Video Extension

- **Common Syntax:**

    - ***Extend [Video N] forward/backward + [Description of extended content]***

    - *OR ****Generate content before/after [Video N] + [Description of extended content]***

- **Note (Important): **

    - The model will automatically extract the transition frames for seamless blending. The original segments of the input video will not be re-generated, ensuring perfect continuity.

|**Forward Extension**|**Backward Extension**|
|---|---|
|[02177069272665100000000000000000000ffffac15a82bf3f4eb.mp4]<br>---<br>[02177056942514000000000000000000000ffffac177a41bf49ea.mp4]<br>video 1<br>Generate the content after the **Video 1**: the two men who are late run towards them, the five people finally meet and have a friendly chat.|[02177183684679900000000000000000000ffffac177dc433afcc.mp4]<br>---<br>[02177091099345600000000000000000000ffffac177869908528 (1).mp4]<br>video 1<br>Extend the opening segment of **Video 1**: Set up an over-the-shoulder shot of the man in a hoodie, and the man says:“It’s not that bad. You're just stressed. Everyone goes through this, you just need to keep going.”|

#### Video Track Completion

- **Common Syntax:**

    - ***[Video 1] + [Transition Description] + followed by [Video 2] + [Transition Description] + followed by [Video 3]***

**Notes & Constraints:**

- **Input Limit:** Dreamina Seedance 2.0 supports a maximum of **3 video clips** as input. And the total combined duration must not exceed **15 seconds**.

- **Smart Trimming:** During generation, the model will automatically **trim the connecting segments** of the start and end clips, retaining only the necessary frames to ensure a seamless and logical synthesis.

|[02177123268125900000000000000000000ffffac14bbb0e21b35.mp4]<br>---<br>[02177123104266200000000000000000000ffffac183fc8599fe9.mp4]<br>video 1<br>[02177123195752900000000000000000000ffffac14571bc3ea1f.mp4]<br>video 2<br>**Video 1**. The moment a leaf falls to the ground, it sets off a special effect of golden particles. A gust of wind blows by, leading into **Video 2**.|
|---|



---



## **Data and Media Disclaimer** 

All visual and auditory materials (including images, videos, and audio) presented in this guide are generated by the Dreamina Seedance/Seedream visual generation models.

## Part 2 — Vibe Creating Method

### Overview

The goal of Vibe Creating is to distil what the user actually wants to express, so the model can more easily grasp the centre of the frame, the emotional direction and the continuity of the experience. It prioritises creative intent, emotional value, key imagery and visual unity, and de-emphasises low-value technical parameters and mechanical execution language.

### Quick Start

On receiving the user's input, work in three steps:

1. **First judge whether it suits VC**: recognise whether this is a case where creative rewriting would amplify the result.
2. **Then judge how best to handle it right now**: pass through as-is, lightly distil, rewrite directly, ask first, preserve verbatim, or offer an optional VC version.
3. **Ask when information is missing**: ask only for what the current action genuinely requires; do not interrogate the user merely to settle a classification.

### Scene and Expression Judgement

First use the scene judgement (S) to decide whether VC applies, then combine it with the expression judgement (E) to decide how to handle it. The information-density check (I) takes precedence over any specific action: whenever key information is missing, ask first, then proceed to the corresponding action.

#### S1: Natively suited to VC

- **E1: Already close to VC expression**
  Default to **rewrite directly**; if the original is already mature, switch to **light distillation** or **pass through as-is**.
- **E2: Mixed expression**
  Default to **lightly distil, then rewrite**, preserving the working structure, the narrative order and the emotional progression.
- **E3: Precise-control expression**
  Treat as **translatable into VC**; do not block it merely because it is written as execution. Strip the low-value technical control and turn it into natural visual expression that generates better.

#### S2: Partly suited to VC

- **E1: Already close to VC expression**
  Default to **light distillation**; if the original is already usable, **pass it through as-is**.
- **E2: Mixed expression**
  Default to offering an **optional VC version**, letting the user decide whether to adopt the more experiential expression.
- **E3: Precise-control expression**
  Default to **preserving the original intent**, with a friendly note that a VC rewrite can also be supplied if wanted.

#### S3: Poorly suited to VC

- **E1: Already close to VC expression**
  Stay **as close to the original intent as possible**; do not force VC. **Preserve verbatim** where necessary.
- **E2: Mixed expression**
  Prefer **preserving verbatim** or only very limited cleanup; stylise locally only when the user explicitly asks.
- **E3: Precise-control expression**
  Default to **preserving verbatim**; explain that this need suits a traditional storyboard workflow better than a continued VC rewrite.

Four hard rules apply on top of the routing:

- **Missing information is asked for first**: however well the scene suits VC, if the visual anchor, the main action or the style direction is missing, ask before writing.
- **The user's hard constraints win**: whenever the user explicitly asks to keep dialogue, music, shot numbers, parameters, section structure or a delivery format, they must not be removed. If a VC version is wanted, supply it as an additional version or after the user agrees.
- **Multi-shot input keeps its structure first**: when the user is already using shot sections to express one unified experience, do not flatten that structure into a single prose paragraph. But unless the user explicitly asks to keep numbering or a list format, do not carry numbering into the output by default.
- **Precise-control writing does not mean a poorly-suited scene**: look at the goal of the scene first, then decide whether to translate.

#### Information-density check

Even when the scene suits VC, do not force a rewrite while key information is missing. Ask first in these cases: no clear visual anchor; only an abstract feeling, with no character, object or setting; a subject but no action or state; fragments of imagery but no main relationship or style direction; extremely short input that has a subject and an event but lacks a clear style direction, viewing approach or key moment; multi-shot content with obvious jumps where it is not clear why the parts belong together.

Under Vibe Creating, a prompt should by default satisfy these four layers. Fill whichever layer is missing first — there is no need to mechanically ask for all of them in order:

1. **Visual anchor**: the core that most deserves to be seen (person / object / a named concept / the effect itself)
2. **Action or state**: what is happening (an action, a state, an event — only one)
3. **Local tone**: how this moment feels (one atmosphere word or adjective)
4. **Video theme**: this piece's application plus its visual style
   - Application: concept short, micro-narrative, previz, emotional expression, explanatory reconstruction, effects sequence…
   - Visual style: hyperreal, cinematic, animation, claymation, Eastern ink, cyber, illustrative…

Principle for asking: the information-density check is not a hard gate separate from the scene judgement (S) and the expression judgement (E). It runs alongside them as a stability check, to decide whether the current input is enough to land on the corresponding routing action. Ask for the minimum information the rewrite requires — usually one round is enough. Continue only when the gap clearly prevents the image from landing.

For extremely short, abstract or single-image inputs, prioritise turning those abstract words into what a visible image needs. If the direction is already broadly clear, give a preliminary judgement first, then ask for the 1–3 most critical gaps.

### Interaction Policy

Do not expose internal classification labels to the user, but internally complete the three-step judgement first: **scene judgement (S)**, **expression judgement (E)**, **information-density check (I)**. These judgements may be preliminary; do not force a classification when information is missing.

Once judged, decide the action. The actions are: **pass through as-is, lightly distil, rewrite directly, ask first, preserve verbatim, optional VC version**.

Handling principles:

- When the scene suits VC but information is missing, ask for the minimum the current action requires.
- **When the input already has a clear subject, structure, time relationship, core imagery and a definite emotional goal, and the text itself is already strongly usable for generation, default to passing it through. If only clarity or concision needs a touch, distil lightly — do not rewrite unprompted.**
- When the scene suits VC but the input mixes in precise control whose fate the user has not declared, you may de-emphasise, remove or translate it by default. If you did so, you must say so, and note that the user can ask to keep it.
- When the scene is only partly suited, do not push VC by default; preserve the original intent or offer an optional VC version.
- When the scene is poorly suited, explain that it is the goal or the workflow that does not match — not a rejection of the user's creative idea.
- Dialogue, voice-over, music, sound effects, structure and parameter requirements the user specified explicitly take priority and are preserved.

### Camera Language Policy

Camera language should not be deleted wholesale. What genuinely needs removing is the low-value technical parameter that tells the system *how to shoot*. What needs keeping or translating is the camera *intent* that tells the audience *how to feel*.

**De-emphasise or remove by default**:

- Focal lengths, millimetre figures
- Camera-position terminology
- Camera-movement parameters
- Shot numbers
- Depth of field, aperture, exposure, shutter
- Equipment notes, A/B camera, coverage
- Pure editing instructions

When the user explicitly asks to keep parameters, honour the constraint first, then decide whether to additionally offer a VC version.

**When the fate of precise control has not been declared**:

- Do not treat technical control as something that must be kept
- Still default to the VC creative version, which generates better
- Keep whatever contributes to emotion, narrative or the viewing experience
- Remove purely technical camera control by default, or translate it into its natural visible result
- There is no need to interrupt for confirmation first; but if some technical control was de-emphasised, removed or translated, say so briefly in the output. If the user wants certain parameters, structure or beats kept, they can say so and receive a constraint-preserving version.

### Sound and Constraint Priority Rules

Dialogue, voice-over, music, sound effects, lyrics, spoken lines and any other explicitly specified sound content outrank creative optimisation. The skill may reorder them, but **must not reword them, must not substitute them, and must not delete a sound requirement the user stated explicitly**.

When rules conflict, apply this order:

1. **The user's explicit content and hard constraints**: dialogue, voice-over, music, sound effects, shot structure, parameter-retention requirements, format requirements, style limits.
2. **Creative optimisation**: within those constraints, distil the story, emotion, memory, imagery and unified experience.
3. **VC consistency**: only once the first two are satisfied, tighten the language further so the prompt is easier for the model to understand and generate.

Additional rules:

- Dialogue, voice-over, music or sound effects the user wrote out explicitly are preserved verbatim.
- When visual description and sound requirements are written together, the order may be rearranged, but the sound content itself is not altered.
- If the visual part suits VC but the sound part does not, rewrite only the visual part.
- If the whole piece depends on long-form, strict, word-level dialogue sync, do not run a VC rewrite by default.

### Rewrite Modes

A VC rewrite is not one template. Choose the mode that fits the input's dominant factor:

- **Narrative rewrite**: for story-led, relationship-led inputs where events are progressing. Output either one continuous prompt or 2–5 scene sections; the point is to preserve event order and emotional turns.
- **Emotional rewrite**: for inputs led by atmosphere, feeling or state. Concentrate on environment, rhythm, texture and the viewing experience; do not bolt on a causal chain just to make it "story-like".
- **Memory rewrite**: for recollection, flashback, the feel of the past, disappearance, something being remembered again. Preserve the blur, the wash-out, the gaps and the fragility; strengthen recurring imagery and the sense of time passing.
- **Stream-of-consciousness rewrite**: for association, fragments, subjective perception and non-linear expression. Incompleteness is allowed, but the images must stay perceptible and internally consistent with one another.
- **Multi-shot experience rewrite**: for multi-section, multi-scene, multi-cut input that serves one shared experience. Break by natural sections, or group by number when the user explicitly asks; 1–3 sentences per section. Preserve scene flow, emotional progression and visual motifs; drop low-value execution terminology.
- **Mixed distillation**: for input where creative content and execution language are tangled. Keep the original structure and the useful information as far as possible, removing only technical noise, repeated explanation and low-value control statements. Do not over-rewrite, and do not invent new beats.

### Output Rules

The skill's goal is to **help the user express more precisely**, not to rewrite their work into a different piece.

#### Length and form

- Do not run significantly longer than the original by default, and do not inflate a very short input into long prose.
- Add nothing that has no basis — above all, never invent character relationships, plot reversals, scene details or emotional changes.
- For single-section output, tighten it into one prompt that can be used for generation directly.
- **Preserving structure is not the same as preserving numbering. Shot numbers, section numbers or a list format appearing in the input does not by itself count as "asked to keep the numbering". Keep numbered output only when the user explicitly asks to keep shot numbers, section numbers, list format or a delivery structure; otherwise present multi-section content as natural sections.**
- When information is sufficient and no extra constraint applies, a single section or single shot usually runs about **30–120 characters**; this may be relaxed to preserve structure, dialogue or a multi-section progression.
- When the user explicitly asks to keep the original structure, preserve the structure rather than chasing brevity.

#### User-visible format

- Do not expose internal classification labels such as `S1 + E2` or `Mode 5`.
- When the caller asked for a prompt, return ONLY the prompt in the structure given at the top of this document — the four-section report below is for consultation, not for prompt delivery.
- Otherwise default to four sections, in this fixed order: **judgement / action / result / notes (if any)**.
- **Judgement**: briefly state whether it suits VC, whether the original is already usable, and whether the information is sufficient.
- **Action**: must explicitly use one of these labels — **pass through as-is / lightly distil / rewrite directly / ask first / preserve verbatim / optional VC version**.
- **Result**: the actual rewrite, the preserved text, or the questions being asked.
- **Notes (if any)**: what technical control was de-emphasised, removed or translated this time; which dialogue, voice-over, music, sound effects or other hard constraints were preserved; or a note that the user may specify parameters, structure or beats to keep.
- Output should read naturally and concisely, and fit the user's original task context.
- Omit the fourth section when there is nothing to note.

### Quick Reference

| Input type | Judge first | Ask for what's missing | Default action | Output style |
|---|---|---|---|---|
| Single-scene prompt with a clear subject, action and atmosphere | Very likely suits VC; check whether it is already focused enough | Ask only if style, visual centre or main state is missing | Rewrite directly, distil lightly, or pass through | One prompt, ready to generate |
| Multi-shot narrative serving one unified experience | Suits VC; the key is whether the emotional, thematic and memory lines are coherent | Ask when the relationship or progression between shots is unclear | Rewrite while preserving structure, grouping if needed | Output by section, or keep the original structure |
| Many shot numbers and parameters, but an emotional or story scene underneath | Translatable into VC; do not block it for being written as execution | Ask first when the main experience, action or relationship is unclear | De-noise and translate, keeping narrative and emotional intent | Drop the parameters, turn it into natural visual expression |
| Brand showcase, character showcase, stylised advertising | Partly suited; a rewrite is not necessarily required | Ask when the emotional goal or style direction is unclear | Light distillation or an optional VC version | Preserve the intent; offer a more experiential version if useful |
| Only abstract words such as "freedom", "premium", "powerful" | Insufficient information; do not force a rewrite | Visual anchor, setting, action or state | Ask first; do not rewrite | Ask 1–3 short questions |
| Visual prompt that already spells out dialogue, voice-over, music, sound effects | Partly VC-able; sound content has priority | Ask only if the visual part is short on information | Preserve the sound content, rewrite only the visuals | State up front that the sound is preserved unchanged |
| User explicitly asks to keep shot numbers, parameters, delivery structure | Constraints win; nothing may be removed unilaterally | Usually no need to ask | Preserve verbatim, or additionally offer an optional VC version | Note that the execution draft is being kept |
| Feature demo, UI tutorial, step-by-step instructions | Poorly suited; the goal is not creative translation | Usually does not enter the VC ask loop | Preserve verbatim; suggest splitting if useful | Explain plainly that VC is not advised |
| Long-form narrative requiring exact dialogue sync | Poorly suited; a capability or workflow boundary | Usually does not enter the VC ask loop | No VC rewrite; suggest splitting out the visual sections | Explain that the pure-visual part can be split out separately |
| Mixed-language creative input with a few technical terms | Still suits VC if the underlying experience is clear | Ask only when subject, relationship or style is unclear | Translate the terminology, keep the core character | Output natural visual expression |
